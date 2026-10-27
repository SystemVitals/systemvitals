"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { useMutation } from "@apollo/client/react";
import { Tabs } from "@base-ui/react/tabs";
import { Check, CircleCheck, Copy, KeyRound, Plus, ShieldCheck, ShieldX, TriangleAlert } from "lucide-react";

import {
  type AgentClient,
  generateAgentConnectionConfig,
} from "@/lib/agent-connection-config";
import { CREATE_API_TOKEN, CREATE_PERSONAL_ACCESS_TOKEN } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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

const CAPABILITIES = ["checks:read", "checks:write"] as const;
const TEST_PROMPT = "Create a 5-minute heartbeat check named nightly-backup.";
type Expiration = "never" | "7" | "30" | "90" | "custom";
const EXPIRATION_LABELS: Record<Expiration, string> = {
  never: "Never",
  "7": "7 days",
  "30": "30 days",
  "90": "90 days",
  custom: "Custom",
};

const CLIENTS: {
  value: AgentClient;
  label: string;
  instruction: string;
  note: string;
}[] = [
  {
    value: "claude-code",
    label: "Claude Code",
    instruction: "Run this in your terminal, then paste the token when prompted.",
    note:
      "The prompt avoids shell history, but the Claude CLI stores the credential in its MCP config. Keep that config private, never commit it, and revoke the token when no longer needed.",
  },
  {
    value: "codex",
    label: "Codex",
    instruction: "Add this to ~/.codex/config.toml.",
    note:
      "This config file contains the bearer secret. Use user-only permissions, keep it private, never commit it, and revoke the token when no longer needed.",
  },
  {
    value: "cursor",
    label: "Cursor",
    instruction: "Add this to ~/.cursor/mcp.json.",
    note:
      "This config file contains the bearer secret. Use user-only permissions, keep it private, never commit it, and revoke the token when no longer needed.",
  },
  {
    value: "universal",
    label: "Universal JSON",
    instruction: "Add this to any MCP client that reads an mcpServers JSON config.",
    note:
      "This config file contains the bearer secret. Use user-only permissions, keep it private, never commit it, and revoke the token when no longer needed.",
  },
  {
    value: "graphql",
    label: "GraphQL/cURL",
    instruction: "Run this in your terminal, then paste the token when prompted.",
    note:
      "Run this example directly. It prompts for the token without putting it in shell history, uses it only for the request, then unsets the variable.",
  },
];
const CLIENT_LABELS = Object.fromEntries(
  CLIENTS.map(({ value, label }) => [value, label]),
) as Record<AgentClient, string>;
const SETUPS_WITH_EMBEDDED_TOKEN = new Set<AgentClient>([
  "codex",
  "cursor",
  "universal",
]);

type CreatedConnection = {
  plaintext: string;
  name: string;
  expiresAt?: string | null;
};

type CreateTokenData = {
  createScopedApiToken?: CreatedConnection;
  createPersonalAccessToken?: CreatedConnection;
};

function expirationDate(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function formatDay(value: Date | string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function StepHeading({ step, title, optional }: { step: number; title: string; optional?: boolean }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-medium">
      <span
        aria-hidden="true"
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
      >
        {step}
      </span>
      {title}
      {optional && <span className="font-normal text-muted-foreground">(optional)</span>}
    </h3>
  );
}

type ConnectionProps = {
  secondary?: boolean;
  onCreated?: () => void;
  onReviewConnections?: () => void;
} & (
  | { scope: "account"; organizationId?: never; organizationName?: never }
  | { scope?: "organization"; organizationId: string; organizationName: string }
);

type PendingExit =
  | { kind: "close" }
  | { kind: "back" }
  | { kind: "link"; href: string };

const HISTORY_GUARD_KEY = "__systemVitalsAgentSecretGuard";
let fallbackGuardSequence = 0;

export function ConnectAgentDialog({
  organizationId = "",
  organizationName = "SystemVitals account",
  scope = "organization",
  onCreated,
  onReviewConnections,
  secondary = false,
}: ConnectionProps) {
  const isAccount = scope === "account";
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pendingExit, setPendingExit] = useState<PendingExit | null>(null);
  const defaultName = (nextClient: AgentClient) =>
    isAccount
      ? CLIENT_LABELS[nextClient]
      : `${CLIENT_LABELS[nextClient]} — ${organizationName}`;
  const [name, setName] = useState(() => defaultName("claude-code"));
  const [nameEdited, setNameEdited] = useState(false);
  const [expiration, setExpiration] = useState<Expiration>(isAccount ? "30" : "never");
  const [customDays, setCustomDays] = useState("");
  const [created, setCreated] = useState<CreatedConnection | null>(null);
  const [creationAtRisk, setCreationAtRisk] = useState(false);
  const [creationUncertain, setCreationUncertain] = useState(false);
  const [uncertaintyAcknowledged, setUncertaintyAcknowledged] = useState(false);
  const [setupCopied, setSetupCopied] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);
  const [tokenAcknowledged, setTokenAcknowledged] = useState(false);
  const [copyError, setCopyError] = useState<"setup" | "token" | null>(null);
  const [client, setClient] = useState<AgentClient>("claude-code");
  const continuingNavigationRef = useRef(false);
  const historyCleanupPendingRef = useRef(false);
  const originalHistoryStateRef = useRef<unknown>(null);
  const guardedUrlRef = useRef("");
  const submitInFlightRef = useRef(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const guardIdRef = useRef<string | null>(null);
  const [createToken, { loading }] = useMutation<CreateTokenData>(
    isAccount ? CREATE_PERSONAL_ACCESS_TOKEN : CREATE_API_TOKEN, {
    fetchPolicy: "no-cache",
    update(cache) {
      cache.evict({ id: "ROOT_QUERY", fieldName: "apiTokens" });
      cache.gc();
    },
  });

  const customDaysValid =
    expiration !== "custom" ||
    (/^\d+$/.test(customDays) &&
      Number(customDays) >= 1 &&
      Number(customDays) <= 3650);
  const canSubmit = name.trim().length > 0 && customDaysValid && !loading;
  const apiUrl = normalizeGraphqlUrl(
    process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8888",
  );
  const config = created
    ? generateAgentConnectionConfig({
        client,
        organizationName,
        apiUrl,
        token: created.plaintext,
        organizationId,
        scope,
      })
    : "";
  const secretSecured = secretCopied || tokenAcknowledged;
  const riskAcknowledged = created
    ? secretSecured
    : creationUncertain && uncertaintyAcknowledged;
  const guardingSecret = open && creationAtRisk && !riskAcknowledged;
  const creationPending =
    creationAtRisk && created === null && !creationUncertain;

  useEffect(() => {
    if (!guardingSecret) return;

    const guardId =
      guardIdRef.current ??
      (typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `agent-guard-${++fallbackGuardSequence}`);
    guardIdRef.current = guardId;
    let installed = false;
    let cancelled = false;
    let installTimer: number | undefined;

    function handlePopState() {
      if (continuingNavigationRef.current) return;
      const stateBase =
        window.history.state !== null &&
        typeof window.history.state === "object"
          ? window.history.state
          : {};
      window.history.pushState(
        { ...stateBase, [HISTORY_GUARD_KEY]: guardId },
        "",
        guardedUrlRef.current,
      );
      setPendingExit({ kind: "back" });
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (continuingNavigationRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }

    function handleDocumentClick(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.hasAttribute("download")
      ) {
        return;
      }
      const targetName = anchor.target.toLowerCase();
      if (targetName !== "" && targetName !== "_self") return;

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;

      event.preventDefault();
      event.stopPropagation();
      setPendingExit({
        kind: "link",
        href: `${destination.pathname}${destination.search}${destination.hash}`,
      });
    }

    function installGuard() {
      if (cancelled) return;
      if (historyCleanupPendingRef.current) {
        installTimer = window.setTimeout(installGuard, 0);
        return;
      }
      if (isOwnedGuardState(window.history.state, guardId)) {
        installed = true;
        return;
      }

      const guardedUrl = window.location.href;
      const originalState = window.history.state as unknown;
      const stateBase =
        originalState !== null && typeof originalState === "object"
          ? originalState
          : {};
      guardedUrlRef.current = guardedUrl;
      originalHistoryStateRef.current = originalState;
      continuingNavigationRef.current = false;
      window.history.pushState(
        { ...stateBase, [HISTORY_GUARD_KEY]: guardId },
        "",
        guardedUrl,
      );
      installed = true;
      window.addEventListener("popstate", handlePopState);
      window.addEventListener("beforeunload", handleBeforeUnload);
      document.addEventListener("click", handleDocumentClick, true);
    }

    installGuard();

    return () => {
      cancelled = true;
      if (installTimer !== undefined) window.clearTimeout(installTimer);
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", handleDocumentClick, true);
      if (
        installed &&
        !continuingNavigationRef.current &&
        isOwnedGuardState(window.history.state, guardId)
      ) {
        historyCleanupPendingRef.current = true;
        const finishCleanup = () => {
          historyCleanupPendingRef.current = false;
          window.removeEventListener("popstate", finishCleanup);
        };
        window.addEventListener("popstate", finishCleanup);
        window.history.back();
        window.setTimeout(finishCleanup, 100);
      }
    };
  }, [guardingSecret]);

  function clearSecretAndClose() {
    setCreated(null);
    setCreationAtRisk(false);
    setCreationUncertain(false);
    setUncertaintyAcknowledged(false);
    setSetupCopied(false);
    setTokenCopied(false);
    setSecretCopied(false);
    setTokenAcknowledged(false);
    setCopyError(null);
    setPendingExit(null);
    setOpen(false);
  }

  function requestClose() {
    if (submitInFlightRef.current || loading) return;
    if (guardingSecret) {
      setPendingExit({ kind: "close" });
      return;
    }
    clearSecretAndClose();
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setClient("claude-code");
      setName(defaultName("claude-code"));
      setNameEdited(false);
      setExpiration(isAccount ? "30" : "never");
      setCustomDays("");
      setCreated(null);
      setCreationAtRisk(false);
      setCreationUncertain(false);
      setUncertaintyAcknowledged(false);
      setSetupCopied(false);
      setTokenCopied(false);
      setSecretCopied(false);
      setTokenAcknowledged(false);
      setCopyError(null);
      setOpen(true);
      return;
    }
    if (submitInFlightRef.current || loading) return;
    requestClose();
  }

  function handleClientChange(nextClient: AgentClient) {
    setClient(nextClient);
    setSetupCopied(false);
    setCopyError(null);
    if (!nameEdited) {
      setName(defaultName(nextClient));
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    flushSync(() => {
      setCreationAtRisk(true);
      setCreationUncertain(false);
      setUncertaintyAcknowledged(false);
      setSetupCopied(false);
      setTokenCopied(false);
      setSecretCopied(false);
      setTokenAcknowledged(false);
      setCopyError(null);
    });
    const selectedDays =
      expiration === "custom" ? Number(customDays) : Number(expiration);
    const input = {
      name: name.trim(),
      capabilities: [...CAPABILITIES],
      organizationId,
      ...(expiration === "never" ? {} : { expirationDays: selectedDays }),
    };

    try {
      const variables = isAccount
        ? {
            name: input.name,
            ...(expiration === "never" ? {} : { expirationDays: selectedDays }),
          }
        : { input };
      const result = await createToken({ variables });
      const connection = isAccount
        ? result.data?.createPersonalAccessToken
        : result.data?.createScopedApiToken;
      if (!connection) throw new Error("Connection could not be created.");
      setCreated({
        plaintext: connection.plaintext,
        name: connection.name,
        expiresAt: connection.expiresAt,
      });
      onCreated?.();
    } catch {
      setCreationUncertain(true);
    } finally {
      submitInFlightRef.current = false;
    }
  }

  async function handleSetupCopy() {
    setCopyError(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(config);
      setSetupCopied(true);
      if (SETUPS_WITH_EMBEDDED_TOKEN.has(client)) {
        setSecretCopied(true);
      }
    } catch {
      setSetupCopied(false);
      setCopyError("setup");
    }
  }

  async function handleTokenCopy() {
    if (!created) return;
    setCopyError(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(created.plaintext);
      setTokenCopied(true);
      setSecretCopied(true);
    } catch {
      setTokenCopied(false);
      setCopyError("token");
    }
  }

  function keepResultOpen() {
    flushSync(() => setPendingExit(null));
    closeButtonRef.current?.focus();
  }

  function confirmPendingExit() {
    const intendedExit = pendingExit;
    if (!intendedExit) return;
    const activeGuardId = guardIdRef.current;

    continuingNavigationRef.current = intendedExit.kind !== "close";
    if (
      intendedExit.kind !== "close" &&
      activeGuardId !== null &&
      isOwnedGuardState(window.history.state, activeGuardId)
    ) {
      window.history.replaceState(
        originalHistoryStateRef.current,
        "",
        guardedUrlRef.current,
      );
    }
    flushSync(clearSecretAndClose);

    if (intendedExit.kind === "back") {
      window.history.go(-2);
    } else if (intendedExit.kind === "link") {
      router.push(intendedExit.href);
    }
  }

  function reviewAgentConnections() {
    if (!creationUncertain || !uncertaintyAcknowledged) return;
    const activeGuardId = guardIdRef.current;

    continuingNavigationRef.current = true;
    if (
      activeGuardId !== null &&
      isOwnedGuardState(window.history.state, activeGuardId)
    ) {
      window.history.replaceState(
        originalHistoryStateRef.current,
        "",
        guardedUrlRef.current,
      );
    }
    flushSync(clearSecretAndClose);
    onReviewConnections?.();
    router.push("/account#personal-access-tokens");
  }

  const testPrompt = isAccount
    ? "List my organizations and show my account subscription and usage."
    : TEST_PROMPT;
  const clientName =
    client === "universal" ? "your MCP client" : CLIENT_LABELS[client];
  const expirationHint =
    expiration === "never"
      ? null
      : customDaysValid && (expiration !== "custom" || customDays !== "")
        ? `Expires on ${formatDay(
            expirationDate(expiration === "custom" ? Number(customDays) : Number(expiration)),
          )}.`
        : null;

  return (
    <>
      <Button
        size="sm"
        variant={isAccount ? "default" : secondary ? "ghost" : "outline"}
        onClick={() => handleOpenChange(true)}
      >
        <Plus className="mr-1 size-4" />
        {isAccount ? 'Create personal access token' : 'Connect agent'}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && pendingExit) {
            keepResultOpen();
            return;
          }
          handleOpenChange(nextOpen);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
        >
          {pendingExit ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {creationPending
                    ? "Leave while the token is being created?"
                    : creationUncertain
                      ? "Acknowledge potential token"
                    : "Close without saving the token?"}
                </DialogTitle>
                <DialogDescription>
                  {creationPending
                    ? "Creation may finish after you leave, resulting in an active token that has never been shown. Keep this setup open unless you accept losing the one-time secret."
                    : creationUncertain
                      ? "A token may be active even though its one-time secret was not received. Keep this warning open, acknowledge the risk, then review your tokens and revoke any potentially created credential."
                    : "The token stays active, but its secret can't be shown again. If you haven't saved it, revoke it from the token list and create a new one."}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" autoFocus onClick={keepResultOpen}>
                  Go back
                </Button>
                {!creationUncertain && (
                  <Button variant="destructive" onClick={confirmPendingExit}>
                    Close anyway
                  </Button>
                )}
              </DialogFooter>
            </>
          ) : creationUncertain ? (
            <div className="space-y-5">
              <div
                role="alert"
                aria-label="Token status unknown"
                className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
              >
                <p className="font-medium">Token status unknown</p>
                <p className="mt-1 text-muted-foreground">
                  The creation request did not return a result. A token may
                  have been created, and its one-time secret was not received.
                  Treat any matching token as active until you review and
                  revoke it from your token list.
                </p>
              </div>

              <div className="flex items-start gap-2">
                <Checkbox
                  id="agent-connection-risk-acknowledged"
                  checked={uncertaintyAcknowledged}
                  onCheckedChange={(checked) =>
                    setUncertaintyAcknowledged(checked === true)
                  }
                />
                <Label
                  htmlFor="agent-connection-risk-acknowledged"
                  className="cursor-pointer text-sm font-normal"
                >
                  I understand a token may have been created, and I will
                  review my tokens to revoke any potentially created
                  credential.
                </Label>
              </div>

              <DialogFooter>
                <Button
                  ref={closeButtonRef}
                  type="button"
                  variant="outline"
                  onClick={requestClose}
                >
                  Close
                </Button>
                <Button
                  type="button"
                  disabled={!uncertaintyAcknowledged}
                  onClick={reviewAgentConnections}
                >
                  Review tokens
                </Button>
              </DialogFooter>
            </div>
          ) : created ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <CircleCheck className="size-5 text-success" aria-hidden="true" />
                  Token created
                </DialogTitle>
                <DialogDescription>
                  <strong className="font-medium text-foreground">{created.name}</strong> is active
                  {created.expiresAt
                    ? ` until ${formatDay(created.expiresAt)}`
                    : " and never expires"}
                  . Finish these steps before closing.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-6">
                <section className="space-y-3" aria-labelledby="agent-token-step">
                  <div id="agent-token-step">
                    <StepHeading step={1} title="Copy your token" />
                  </div>
                  <div
                    role="alert"
                    className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
                  >
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                    <div>
                      <p className="font-medium">This is the only time you&apos;ll see this token</p>
                      <p className="mt-1 text-muted-foreground">
                        It cannot be displayed again. Store it in a password manager or your
                        agent&apos;s config. Never commit the token or generated config to
                        source control.
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                    <Label htmlFor="agent-token" className="sr-only">
                      One-time token
                    </Label>
                    <pre
                      id="agent-token"
                      className="min-w-0 flex-1 overflow-x-auto rounded-lg border bg-muted px-3 py-2.5 font-mono text-sm select-all"
                    >
                      {created.plaintext}
                    </pre>
                    <Button
                      type="button"
                      variant={tokenCopied ? "outline" : "default"}
                      className="sm:h-auto"
                      onClick={handleTokenCopy}
                    >
                      {tokenCopied ? (
                        <Check className="mr-1 size-4" />
                      ) : (
                        <Copy className="mr-1 size-4" />
                      )}
                      {tokenCopied ? "Token copied" : "Copy token"}
                    </Button>
                  </div>
                  {copyError === "token" && (
                    <p role="alert" aria-label="Copy failed" className="text-sm text-destructive">
                      Could not copy the token. Copy it manually from the one-time token above, then confirm that you saved it.
                    </p>
                  )}
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="agent-token-saved"
                      checked={tokenAcknowledged || tokenCopied}
                      disabled={tokenCopied}
                      onCheckedChange={(checked) =>
                        setTokenAcknowledged(checked === true)
                      }
                    />
                    <Label
                      htmlFor="agent-token-saved"
                      className="cursor-pointer text-sm font-normal"
                    >
                      I saved this one-time token securely.
                    </Label>
                  </div>
                </section>

                <section className="space-y-3" aria-labelledby="agent-setup-step">
                  <div id="agent-setup-step">
                    <StepHeading step={2} title="Connect your agent" optional />
                  </div>
                  <Tabs.Root
                    value={client}
                    onValueChange={(value) => handleClientChange(value as AgentClient)}
                  >
                    <Tabs.List
                      aria-label="Agent client configuration"
                      className="flex gap-1 overflow-x-auto border-b"
                    >
                      {CLIENTS.map((item) => (
                        <Tabs.Tab
                          key={item.value}
                          value={item.value}
                          className="shrink-0 border-b-2 border-transparent px-2 py-2 text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-active:border-primary data-active:text-foreground sm:text-sm"
                        >
                          {item.label}
                        </Tabs.Tab>
                      ))}
                    </Tabs.List>
                    {CLIENTS.map((item) => (
                      <Tabs.Panel
                        key={item.value}
                        value={item.value}
                        className="space-y-2 pt-3 outline-none"
                      >
                        <p className="text-sm">{item.instruction}</p>
                        <div className="relative">
                          <pre className="max-h-56 overflow-auto rounded-lg bg-muted p-3 pr-28 font-mono text-xs whitespace-pre-wrap break-all">
                            {config}
                          </pre>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="absolute right-2 top-2 bg-background"
                            onClick={handleSetupCopy}
                          >
                            {setupCopied ? <Check className="mr-1 size-4" /> : <Copy className="mr-1 size-4" />}
                            {setupCopied ? "Setup copied" : "Copy setup"}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">{item.note}</p>
                      </Tabs.Panel>
                    ))}
                  </Tabs.Root>
                  {copyError === "setup" && (
                    <p role="alert" aria-label="Copy failed" className="text-sm text-destructive">
                      Could not copy the setup. Copy it manually from the configuration above.
                    </p>
                  )}
                </section>

                {client !== "graphql" && (
                  <section className="space-y-2" aria-labelledby="agent-test-step">
                    <div id="agent-test-step">
                      <StepHeading step={3} title={`Try it in ${clientName}`} optional />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Start a new {clientName} session and ask:
                    </p>
                    <p className="rounded-lg border bg-muted/40 px-3 py-2 font-mono text-sm">{testPrompt}</p>
                  </section>
                )}
              </div>

              <DialogFooter>
                {!secretSecured && (
                  <p className="mr-auto self-center text-xs text-muted-foreground">
                    Copy the token or confirm you saved it to finish.
                  </p>
                )}
                <Button ref={closeButtonRef} onClick={requestClose}>
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <KeyRound className="size-5 text-primary" aria-hidden="true" />
                  {isAccount ? 'Create personal access token' : 'Connect agent'}
                </DialogTitle>
                <DialogDescription>
                  {isAccount ? 'Let an AI agent or script manage SystemVitals on your behalf.' : <>
                    Create an organization-scoped token for{' '}
                    <strong>{organizationName}</strong>.
                  </>}
                </DialogDescription>
              </DialogHeader>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="agent-client">Agent client</Label>
                <Select
                  value={client}
                  onValueChange={(value) =>
                    value && handleClientChange(value as AgentClient)
                  }
                >
                  <SelectTrigger id="agent-client" className="w-full">
                    <SelectValue>{CLIENT_LABELS[client]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {CLIENTS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  You&apos;ll get ready-to-paste setup for it after the token is created.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="agent-name">Token name</Label>
                <Input
                  id="agent-name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameEdited(true);
                  }}
                  aria-describedby="agent-name-help"
                  required
                />
                <p id="agent-name-help" className="text-xs text-muted-foreground">
                  Name it after the agent and machine, like &ldquo;Claude Code on work laptop&rdquo;, so you
                  can recognize it later.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="agent-expiration">Expiration</Label>
                <Select
                  value={expiration}
                  onValueChange={(value) => value && setExpiration(value as Expiration)}
                >
                  <SelectTrigger id="agent-expiration" className="w-full">
                    <SelectValue>{EXPIRATION_LABELS[expiration]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="never">Never</SelectItem>
                    <SelectItem value="7">7 days</SelectItem>
                    <SelectItem value="30">30 days</SelectItem>
                    <SelectItem value="90">90 days</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
                {expiration === "never" ? (
                  <p className="text-xs text-warning">
                    This token will work until you revoke it. Prefer an expiration for agents you
                    don&apos;t fully control.
                  </p>
                ) : (
                  expirationHint && (
                    <p className="text-xs text-muted-foreground">{expirationHint}</p>
                  )
                )}
              </div>

              {expiration === "custom" && (
                <div className="space-y-2">
                  <Label htmlFor="agent-custom-days">Custom expiration (days)</Label>
                  <Input
                    id="agent-custom-days"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={3650}
                    step={1}
                    value={customDays}
                    onChange={(event) => setCustomDays(event.target.value)}
                    aria-invalid={!customDaysValid}
                    aria-describedby={
                      customDaysValid
                        ? "agent-custom-days-help"
                        : "agent-custom-days-help agent-custom-days-error"
                    }
                  />
                  <p id="agent-custom-days-help" className="text-xs text-muted-foreground">
                    Choose a whole number from 1 to 3650 days.
                  </p>
                  {!customDaysValid && (
                    <p id="agent-custom-days-error" role="alert" className="text-sm text-destructive">
                      Enter a whole number from 1 to 3650.
                    </p>
                  )}
                </div>
              )}

              <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                <p className="text-sm font-medium">What this token can do</p>
                {isAccount ? <ul className="space-y-1.5 text-sm">
                  <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                    Manage all organizations you can access: checks, channels, members, invitations, and status pages.
                  </li>
                  <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                    View subscription and usage, and create billing checkout and portal links.
                  </li>
                  <li className="flex gap-2 text-muted-foreground"><ShieldX className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    It can&apos;t change your password or manage tokens — password changes and token administration require your login session.
                  </li>
                  <li className="pt-1 text-xs text-muted-foreground">
                    Uses your current organization roles, including organizations you join later. Billing changes are completed through Stripe&apos;s hosted pages.
                  </li>
                </ul> : <>
                <ul className="space-y-1.5 text-sm">
                  <li className="flex gap-2">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                    View checks and recent status.
                  </li>
                  <li className="flex gap-2">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                    Create, edit, pause, resume, and delete checks.
                  </li>
                </ul>
                <p className="text-sm text-muted-foreground">
                  Limited to <strong>{organizationName}</strong>. No access to
                  members, billing, notification channels, or other
                  organizations.
                </p>
                </>}
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={loading}
                  onClick={requestClose}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={!canSubmit}>
                  {loading ? "Creating…" : "Create token"}
                </Button>
              </DialogFooter>
            </form>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function normalizeGraphqlUrl(value: string): string {
  const normalized = value.replace(/\/+$/, "");
  return normalized.endsWith("/graphql") ? normalized : `${normalized}/graphql`;
}

function isOwnedGuardState(state: unknown, guardId: string): boolean {
  return (
    state !== null &&
    typeof state === "object" &&
    HISTORY_GUARD_KEY in state &&
    (state as Record<string, unknown>)[HISTORY_GUARD_KEY] === guardId
  );
}
