"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import {
  useApolloClient,
  useLazyQuery,
  useMutation,
} from "@apollo/client/react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  MessageSquare,
  Radio,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import {
  CONNECT_TELEGRAM_CHANNEL,
  TELEGRAM_CONNECTION_PREVIEW,
} from "@/lib/queries";

const CONNECT_PATH = "/channels/telegram/connect";

interface TelegramPreview {
  chatId: string;
  chatType: string;
  chatTitle: string | null;
  messageThreadId: number | null;
  expiresAt: string;
}

interface PreviewData {
  telegramConnectionPreview: TelegramPreview;
}

interface ProjectOption {
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
}

interface Recovery {
  title: string;
  description: string;
  actionLabel?: string;
}

const INVALID_LINK: Recovery = {
  title: "This connection link is invalid",
  description:
    "Return to Telegram and request a new connection link from the SystemVitals bot.",
};

function recoveryFor(message: string): Recovery {
  const normalized = message.toLowerCase();

  if (normalized.includes("expired")) {
    return {
      title: "This connection link has expired",
      description:
        "Request a new connection link in Telegram, then open it while it is still active.",
    };
  }

  if (
    normalized.includes("consumed") ||
    normalized.includes("already used") ||
    normalized.includes("already been used")
  ) {
    return {
      title: "This connection link was already used",
      description:
        "Request a new connection link in Telegram to connect another project.",
    };
  }

  if (
    normalized.includes("duplicate") ||
    normalized.includes("already connected")
  ) {
    return {
      title: "This Telegram destination is already connected",
      description:
        "Choose another project, or review the existing destination on the Channels page.",
    };
  }

  if (normalized.includes("invalid") || normalized.includes("not found")) {
    return INVALID_LINK;
  }

  return {
    title: "Telegram connection is unavailable",
    description:
      "Try again later. If the problem continues, request a new connection link in Telegram.",
  };
}

function mutationRecoveryFor(message: string): Recovery {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("project not found") ||
    normalized.includes("not a member of this organization")
  ) {
    return {
      title: "Project access changed",
      description:
        "You no longer have access to that project. Choose another accessible project and try again, or refresh the page.",
      actionLabel: "Choose another project",
    };
  }

  return recoveryFor(message);
}

function formatChatType(chatType: string): string {
  return chatType
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatExpiry(expiresAt: string): string {
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return "soon";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(expiry);
}

function LoadingCard() {
  return (
    <Card
      aria-busy="true"
      aria-label="Loading Telegram connection"
      className="w-full max-w-2xl border-primary/15"
    >
      <CardContent className="flex min-h-56 items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Radio className="size-4 animate-pulse text-primary" aria-hidden="true" />
          Verifying Telegram destination…
        </div>
      </CardContent>
    </Card>
  );
}

function RecoveryCard({ recovery }: { recovery: Recovery }) {
  const router = useRouter();

  return (
    <Card className="w-full max-w-2xl border-destructive/20">
      <CardHeader>
        <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
          <TriangleAlert className="size-5" aria-hidden="true" />
        </div>
        <CardTitle>
          <h1 className="text-xl">{recovery.title}</h1>
        </CardTitle>
        <CardDescription className="max-w-lg leading-relaxed">
          {recovery.description}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          onClick={() => router.push("/channels")}
        >
          Return to channels
        </Button>
      </CardContent>
    </Card>
  );
}

function ChallengeConfirmation() {
  const router = useRouter();
  const client = useApolloClient();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { setActiveOrgId } = useOrg();
  const tokenRef = useRef<string | null>(null);
  const handledRef = useRef(false);
  const [missingToken, setMissingToken] = useState(false);
  const projects: ProjectOption[] =
    user?.organizations.flatMap((organization) =>
      organization.projects.map((project) => ({
        id: project.id,
        name: project.name,
        organizationId: organization.id,
        organizationName: organization.name,
      })),
    ) ?? [];
  const firstProjectId = projects.at(0)?.id ?? "";
  const [selectedProjectId, setSelectedProjectId] = useState(firstProjectId);
  const [mutationRecovery, setMutationRecovery] = useState<Recovery | null>(
    null,
  );

  const [loadPreview, { data, loading, error, called }] =
    useLazyQuery<PreviewData>(TELEGRAM_CONNECTION_PREVIEW, {
      fetchPolicy: "no-cache",
    });
  const [connectTelegram, { loading: connecting }] = useMutation(
    CONNECT_TELEGRAM_CHANNEL,
  );

  useEffect(() => {
    if (handledRef.current) return;
    handledRef.current = true;

    const token = searchParams.get("token");
    tokenRef.current = token;

    if (!token) {
      Promise.resolve().then(() => setMissingToken(true));
      return;
    }

    window.history.replaceState({}, "", CONNECT_PATH);
    void loadPreview({ variables: { token } }).catch(() => {
      // Apollo exposes the sanitized failure state through `error`.
    });
  }, [loadPreview, searchParams]);

  if (missingToken) {
    return <RecoveryCard recovery={INVALID_LINK} />;
  }

  if (!called || loading) {
    return <LoadingCard />;
  }

  if (error || !data?.telegramConnectionPreview) {
    return <RecoveryCard recovery={recoveryFor(error?.message ?? "invalid")} />;
  }

  const preview = data.telegramConnectionPreview;
  const chatTitle =
    preview.chatTitle?.trim() ||
    (preview.chatType.toLowerCase() === "private"
      ? "Unnamed private chat"
      : "Unnamed Telegram chat");
  const selectItems = projects.map((project) => ({
    value: project.id,
    label: `${project.organizationName} / ${project.name}`,
  }));

  async function handleConnect() {
    if (!selectedProjectId || connecting) return;

    const token = tokenRef.current;
    const project = projects.find(
      (candidate) => candidate.id === selectedProjectId,
    );
    if (!token || !project) return;

    setMutationRecovery(null);
    try {
      await connectTelegram({
        variables: {
          token,
          projectId: project.id,
        },
      });
    } catch (connectionError) {
      const message =
        connectionError instanceof Error ? connectionError.message : "";
      setMutationRecovery(mutationRecoveryFor(message));
      return;
    }

    client.cache.evict({
      id: "ROOT_QUERY",
      fieldName: "channels",
      args: { projectId: project.id },
    });
    client.cache.gc();
    setActiveOrgId(project.organizationId);
    router.push(`/channels?projectId=${encodeURIComponent(project.id)}`);
  }

  return (
    <>
      <Card className="w-full max-w-2xl border-primary/20 shadow-sm">
        <CardHeader className="border-b bg-muted/30 pb-5">
          <div className="mb-2 flex items-center gap-2 font-mono text-[0.68rem] font-medium uppercase tracking-[0.18em] text-primary">
            <span className="size-1.5 rounded-full bg-success" />
            Destination verified
          </div>
          <CardTitle>
            <h1 className="text-xl sm:text-2xl">Confirm Telegram connection</h1>
          </CardTitle>
          <CardDescription>
            Review the destination, then choose which project should send
            alerts here.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6 pt-2">
          <section aria-labelledby="telegram-destination-heading">
            <h2
              id="telegram-destination-heading"
              className="mb-3 font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              Telegram destination
            </h2>
            <div className="grid gap-3 rounded-lg border bg-background p-4 sm:grid-cols-[auto_1fr] sm:items-center">
              <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                <MessageSquare className="size-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="truncate font-heading text-base font-semibold">
                  {chatTitle}
                </p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
                  <span>{formatChatType(preview.chatType)}</span>
                  {preview.messageThreadId !== null && (
                    <span>Topic {preview.messageThreadId}</span>
                  )}
                </div>
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Connection link expires{" "}
              <time dateTime={preview.expiresAt}>
                {formatExpiry(preview.expiresAt)}
              </time>
              .
            </p>
          </section>

          <section
            aria-labelledby="project-destination-heading"
            className="space-y-2"
          >
            <div>
              <Label
                id="project-destination-heading"
                htmlFor="telegram-project"
              >
                Destination project
              </Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Alerts from this project will be delivered to the destination
                above.
              </p>
            </div>

            {projects.length > 0 ? (
              <Select
                items={selectItems}
                value={selectedProjectId}
                onValueChange={(value) => {
                  if (value) setSelectedProjectId(value);
                }}
              >
                <SelectTrigger
                  id="telegram-project"
                  aria-labelledby="project-destination-heading"
                  className="h-10 w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  {user?.organizations.map((organization) => (
                    <SelectGroup key={organization.id}>
                      <SelectLabel>{organization.name}</SelectLabel>
                      {organization.projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                No accessible projects are available. Create a project before
                connecting this destination.
              </p>
            )}
          </section>

          <div className="flex flex-col-reverse gap-2 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
              SystemVitals will manage delivery credentials.
            </p>
            <Button
              onClick={() => void handleConnect()}
              disabled={!selectedProjectId || connecting}
              className="w-full gap-2 sm:w-auto"
            >
              {connecting ? "Connecting…" : "Connect Telegram"}
              {!connecting && <ArrowRight className="size-4" aria-hidden="true" />}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={mutationRecovery !== null}
        onOpenChange={(open) => {
          if (!open) setMutationRecovery(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mutationRecovery?.title}</DialogTitle>
            <DialogDescription>
              {mutationRecovery?.description}
            </DialogDescription>
          </DialogHeader>
          <Button onClick={() => setMutationRecovery(null)}>
            {mutationRecovery?.actionLabel ?? "Dismiss"}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function TelegramConnectPage() {
  return (
    <div className="flex min-h-[calc(100dvh-8rem)] items-start justify-center px-0 py-4 sm:items-center sm:py-8">
      <Suspense fallback={<LoadingCard />}>
        <ChallengeConfirmation />
      </Suspense>
    </div>
  );
}
