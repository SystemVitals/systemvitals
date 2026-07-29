"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@apollo/client/react";
import { Hash, Mail, MessageSquare, Plus, Trash2, Webhook } from "lucide-react";
import { ManagedTelegramSetup } from "@/components/channels/managed-telegram-setup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  buildChannelConfig,
  type CreatableChannelType,
} from "@/lib/channel-config";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import {
  CHANNELS,
  CREATE_CHANNEL,
  DELETE_CHANNEL,
  MANAGED_TELEGRAM_BOT,
  RESEND_EMAIL_CHANNEL_VERIFICATION,
} from "@/lib/queries";

interface Channel {
  id: string;
  type: string;
  configJson: string;
  enabled: boolean;
  verificationStatus: "NOT_REQUIRED" | "PENDING" | "VERIFIED";
  verificationDeliveryStatus: "NOT_REQUIRED" | "SENT" | "NOT_SENT";
  verificationExpiresAt: string | null;
}

interface CreateChannelVariables {
  organizationId: string;
  type: string;
  configJson: string;
}

interface EmailConfig {
  email?: string;
}

interface SlackConfig {
  webhookUrl?: string;
}

interface TelegramConfig {
  mode?: unknown;
  chatId?: unknown;
  chatTitle?: unknown;
  messageThreadId?: unknown;
}

interface WebhookConfig {
  url?: string;
}

interface TelegramPresentation {
  summary: string;
  mode: "LEGACY" | "MANAGED" | null;
}

function truncateUrl(url: string, max = 40): string {
  if (url.length <= max) return url;
  return url.slice(0, max) + "…";
}

function formatVerificationExpiry(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function nonblankString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseTelegramPresentation(configJson: string): TelegramPresentation {
  try {
    const parsed: unknown = JSON.parse(configJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { summary: "Telegram destination", mode: null };
    }

    const config = parsed as TelegramConfig;
    const destination =
      nonblankString(config.chatTitle) ??
      nonblankString(config.chatId) ??
      "Telegram destination";
    const topic =
      typeof config.messageThreadId === "number" &&
      Number.isFinite(config.messageThreadId)
        ? ` · topic: ${config.messageThreadId}`
        : "";
    const mode =
      config.mode === "LEGACY" || config.mode === "MANAGED"
        ? config.mode
        : null;

    return { summary: `${destination}${topic}`, mode };
  } catch {
    return { summary: "Telegram destination", mode: null };
  }
}

function parseConfigSummary(type: string, configJson: string): string {
  try {
    switch (type) {
      case "EMAIL": {
        const config = JSON.parse(configJson) as EmailConfig;
        return config.email ?? configJson;
      }
      case "SLACK": {
        const config = JSON.parse(configJson) as SlackConfig;
        return config.webhookUrl
          ? truncateUrl(config.webhookUrl)
          : configJson;
      }
      case "TELEGRAM":
        return parseTelegramPresentation(configJson).summary;
      case "WEBHOOK": {
        const config = JSON.parse(configJson) as WebhookConfig;
        return config.url ? truncateUrl(config.url) : configJson;
      }
      default:
        return configJson;
    }
  } catch {
    return type === "TELEGRAM" ? "Telegram destination" : configJson;
  }
}

const TYPE_LABELS: Record<string, string> = {
  EMAIL: "Email",
  SLACK: "Slack",
  TELEGRAM: "Telegram",
  WEBHOOK: "Webhook",
};

function ChannelTypeIcon({ type }: { type: string }) {
  switch (type) {
    case "EMAIL":
      return <Mail className="size-4 shrink-0 text-muted-foreground" />;
    case "SLACK":
      return <Hash className="size-4 shrink-0 text-muted-foreground" />;
    case "TELEGRAM":
      return (
        <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
      );
    case "WEBHOOK":
      return <Webhook className="size-4 shrink-0 text-muted-foreground" />;
    default:
      return null;
  }
}

interface TypeFieldsProps {
  type: CreatableChannelType;
  email: string;
  setEmail: (value: string) => void;
  webhookUrl: string;
  setWebhookUrl: (value: string) => void;
  url: string;
  setUrl: (value: string) => void;
}

export function TypeFields({
  type,
  email,
  setEmail,
  webhookUrl,
  setWebhookUrl,
  url,
  setUrl,
}: TypeFieldsProps) {
  switch (type) {
    case "EMAIL":
      return (
        <div className="flex-1 space-y-1">
          <Label htmlFor="channel-email" className="sr-only">
            Email address
          </Label>
          <Input
            id="channel-email"
            type="email"
            placeholder="alerts@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
      );
    case "SLACK":
      return (
        <div className="flex-1 space-y-1">
          <Label htmlFor="channel-webhook-url" className="sr-only">
            Slack webhook URL
          </Label>
          <Input
            id="channel-webhook-url"
            type="url"
            placeholder="https://hooks.slack.com/services/…"
            value={webhookUrl}
            onChange={(event) => setWebhookUrl(event.target.value)}
            required
          />
        </div>
      );
    case "WEBHOOK":
      return (
        <div className="flex-1 space-y-1">
          <Label htmlFor="channel-url" className="sr-only">
            Webhook URL
          </Label>
          <Input
            id="channel-url"
            type="url"
            placeholder="https://example.com/hook"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            required
          />
        </div>
      );
  }
}

interface ManagedTelegramBotData {
  managedTelegramBot: {
    available: boolean;
    username: string | null;
  };
}

interface ChannelsListProps {
  organizationId: string;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

function ChannelsList({ organizationId }: ChannelsListProps) {
  const [channelType, setChannelType] =
    useState<CreatableChannelType>("EMAIL");
  const [email, setEmail] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [url, setUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [resendingIds, setResendingIds] = useState<Set<string>>(new Set());
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const {
    data,
    refetch,
    loading,
    error: queryError,
  } = useQuery<{ channels: Channel[] }>(CHANNELS, {
    variables: { organizationId },
  });
  const {
    data: managedBotData,
    loading: managedBotLoading,
    error: managedBotError,
  } = useQuery<ManagedTelegramBotData>(MANAGED_TELEGRAM_BOT, {
    fetchPolicy: "network-only",
  });

  const [createChannel, { loading: creating }] = useMutation<
    { createChannel: Channel },
    CreateChannelVariables
  >(CREATE_CHANNEL, {
    update: (cache, { data: mutationData }, { variables }) => {
      const createdChannel = mutationData?.createChannel;
      if (!createdChannel || !variables) return;

      try {
        const cached = cache.readQuery<{ channels: Channel[] }>({
          query: CHANNELS,
          variables: { organizationId: variables.organizationId },
        });
        const cachedChannels = cached?.channels ?? [];

        const completeChannel: Channel = {
          ...createdChannel,
          type: variables.type,
          configJson: variables.configJson,
        };
        const existingIndex = cachedChannels.findIndex(
          (channel) => channel.id === completeChannel.id
        );
        const channels =
          existingIndex === -1
            ? [...cachedChannels, completeChannel]
            : cachedChannels.map((channel, index) =>
                index === existingIndex ? completeChannel : channel
              );

        cache.writeQuery({
          query: CHANNELS,
          variables: { organizationId: variables.organizationId },
          data: { channels },
        });
      } catch (error) {
        setErrorMessage(
          getErrorMessage(error, "Unable to display the new channel.")
        );
      }
    },
    onCompleted: ({ createChannel: createdChannel }) => {
      setEmail("");
      setWebhookUrl("");
      setUrl("");
      if (
        createdChannel.verificationStatus === "PENDING" &&
        createdChannel.verificationDeliveryStatus === "SENT"
      ) {
        setSuccessMessage(
          "Verification email sent. This channel is inactive until verified."
        );
      } else if (
        createdChannel.verificationStatus === "PENDING" &&
        createdChannel.verificationDeliveryStatus === "NOT_SENT"
      ) {
        setSuccessMessage(
          "Verification could not be sent. This channel remains inactive until verified; use resend to try again."
        );
      }
      void refetch().catch((error: unknown) => {
        setErrorMessage(getErrorMessage(error, "Unable to refresh channels."));
      });
    },
  });

  const [deleteChannel, { loading: deleting }] = useMutation(DELETE_CHANNEL, {
    onCompleted: () => {
      setConfirmDeleteId(null);
      void refetch().catch((error: unknown) => {
        setErrorMessage(getErrorMessage(error, "Unable to refresh channels."));
      });
    },
  });
  const [resendEmailVerification] = useMutation<{
    resendEmailChannelVerification?: Channel | null;
  }>(RESEND_EMAIL_CHANNEL_VERIFICATION);

  useEffect(() => {
    if (queryError) {
      Promise.resolve().then(() => setErrorMessage(queryError.message));
    }
  }, [queryError]);

  function handleTypeChange(value: CreatableChannelType | null) {
    if (!value) return;
    setChannelType(value);
    setEmail("");
    setWebhookUrl("");
    setUrl("");
  }

  function buildConfig(): string {
    switch (channelType) {
      case "EMAIL":
        return buildChannelConfig("EMAIL", { email });
      case "SLACK":
        return buildChannelConfig("SLACK", { webhookUrl });
      case "WEBHOOK":
        return buildChannelConfig("WEBHOOK", { url });
    }
  }

  async function handleAddChannel(event: React.FormEvent) {
    event.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      await createChannel({
        variables: {
          organizationId,
          type: channelType,
          configJson: buildConfig(),
        },
      });
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Unable to add channel."));
    }
  }

  async function handleResendVerification(channelId: string) {
    setErrorMessage(null);
    setSuccessMessage(null);
    setResendingIds((current) => new Set(current).add(channelId));

    try {
      const result = await resendEmailVerification({
        variables: { channelId },
      });
      const returnedChannel = result.data?.resendEmailChannelVerification;
      if (
        returnedChannel?.id === channelId &&
        returnedChannel.verificationDeliveryStatus === "SENT"
      ) {
        setSuccessMessage("Verification email sent.");
      } else {
        setErrorMessage(
          "Verification could not be sent. Please try again."
        );
      }
    } catch (error) {
      setErrorMessage(
        getErrorMessage(error, "Unable to resend verification email.")
      );
    } finally {
      setResendingIds((current) => {
        const next = new Set(current);
        next.delete(channelId);
        return next;
      });
    }
  }

  async function handleDeleteChannel() {
    if (!confirmDeleteId) return;

    const channelId = confirmDeleteId;
    try {
      await deleteChannel({
        variables: { id: channelId },
      });
    } catch (error) {
      setConfirmDeleteId(null);
      setErrorMessage(getErrorMessage(error, "Unable to delete channel."));
    }
  }

  const channels = data?.channels ?? [];
  const managedBot = managedBotData?.managedTelegramBot;

  return (
    <div className="space-y-6">
      {managedBotLoading ? (
        <div
          role="status"
          aria-label="Loading Telegram setup"
          aria-live="polite"
          className="min-h-40 sm:min-h-48"
        >
          <Skeleton
            aria-hidden="true"
            className="h-full min-h-40 w-full rounded-xl sm:min-h-48"
          />
        </div>
      ) : (
        <ManagedTelegramSetup
          available={!managedBotError && managedBot?.available === true}
          username={managedBotError ? null : (managedBot?.username ?? null)}
        />
      )}

      {successMessage && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-foreground"
        >
          {successMessage}
        </div>
      )}

      {loading && (
        <div className="space-y-2" aria-label="Loading channels">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      )}

      {!loading && channels.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-6 text-center">
            <p className="text-sm text-muted-foreground">
              Channels are where your alerts go — email, Slack, Telegram, or
              webhook.
            </p>
          </CardContent>
        </Card>
      )}

      {channels.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y overflow-hidden rounded-xl">
              {channels.map((channel) => {
                const telegram =
                  channel.type === "TELEGRAM"
                    ? parseTelegramPresentation(channel.configJson)
                    : null;
                const summary = parseConfigSummary(
                  channel.type,
                  channel.configJson
                );

                return (
                  <div
                    key={channel.id}
                    data-channel-row
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap"
                  >
                    <ChannelTypeIcon type={channel.type} />
                    <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">
                      {TYPE_LABELS[channel.type] ?? channel.type}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{summary}</p>
                      {telegram?.mode === "LEGACY" && (
                        <Badge variant="outline" className="mt-1">
                          Legacy custom bot
                        </Badge>
                      )}
                      {telegram?.mode === "MANAGED" && (
                        <Badge
                          variant="outline"
                          className="mt-1 border-primary/30 text-primary"
                        >
                          SystemVitals bot
                        </Badge>
                      )}
                      {channel.type === "EMAIL" &&
                        channel.verificationStatus === "PENDING" && (
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                            <Badge
                              variant="outline"
                              className="border-warning/40 bg-warning/10 text-warning"
                            >
                              Verification pending
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {channel.verificationExpiresAt ? (
                                <>
                                  Link expires{" "}
                                  <time dateTime={channel.verificationExpiresAt}>
                                    {formatVerificationExpiry(
                                      channel.verificationExpiresAt
                                    )}{" "}
                                    UTC
                                  </time>
                                  .
                                </>
                              ) : (
                                "Request a new verification link."
                              )}
                            </span>
                          </div>
                        )}
                    </div>
                    {channel.type === "EMAIL" &&
                    channel.verificationStatus === "PENDING" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={resendingIds.has(channel.id)}
                        aria-label={`Resend verification to ${summary}`}
                        onClick={() => void handleResendVerification(channel.id)}
                        className="h-8 shrink-0"
                      >
                        {resendingIds.has(channel.id)
                          ? "Sending…"
                          : "Resend verification"}
                      </Button>
                    ) : (
                      <span
                        className={`shrink-0 text-xs ${
                          channel.enabled
                            ? "text-success"
                            : "text-muted-foreground"
                        }`}
                      >
                        {channel.enabled ? "Active" : "Disabled"}
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setConfirmDeleteId(channel.id)}
                      aria-label={`Delete ${
                        TYPE_LABELS[channel.type] ?? channel.type
                      } channel ${summary}`}
                      className="shrink-0 text-destructive hover:text-destructive"
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Plus className="size-4" />
            Add channel
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAddChannel} className="space-y-3">
            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start">
              <div className="sm:w-36 sm:shrink-0">
                <Label htmlFor="channel-type" className="sr-only">
                  Channel type
                </Label>
                <Select value={channelType} onValueChange={handleTypeChange}>
                  <SelectTrigger id="channel-type" className="w-full">
                    <SelectValue>{TYPE_LABELS[channelType]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="EMAIL">Email</SelectItem>
                    <SelectItem value="SLACK">Slack</SelectItem>
                    <SelectItem value="WEBHOOK">Webhook</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <TypeFields
                type={channelType}
                email={email}
                setEmail={setEmail}
                webhookUrl={webhookUrl}
                setWebhookUrl={setWebhookUrl}
                url={url}
                setUrl={setUrl}
              />

              <Button
                type="submit"
                disabled={creating}
                className="sm:shrink-0"
              >
                {creating ? "Adding…" : "Add"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Dialog
        open={!!confirmDeleteId}
        onOpenChange={(open: boolean) => {
          if (!open) setConfirmDeleteId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete channel?</DialogTitle>
            <DialogDescription>
              This channel will no longer receive alerts. This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setConfirmDeleteId(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void handleDeleteChannel()}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!errorMessage} onOpenChange={() => setErrorMessage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Error</DialogTitle>
            <DialogDescription>{errorMessage}</DialogDescription>
          </DialogHeader>
          <Button onClick={() => setErrorMessage(null)}>Dismiss</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function ChannelsPage() {
  const { user } = useAuth();
  const { activeOrg } = useOrg();

  if (!user) return null;

  return (
    <div className="space-y-6 px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Channels
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Notification destinations for your alerts.
        </p>
      </div>

      {!activeOrg ? (
        <p className="text-muted-foreground">No organizations found.</p>
      ) : (
        <ChannelsList
          key={activeOrg.id}
          organizationId={activeOrg.id}
        />
      )}
    </div>
  );
}
