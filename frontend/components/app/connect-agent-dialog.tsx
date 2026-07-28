"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { useMutation } from "@apollo/client/react";
import { Tabs } from "@base-ui/react/tabs";
import { Check, Copy, Plug, ShieldCheck } from "lucide-react";

import {
  type AgentClient,
  generateAgentConnectionConfig,
} from "@/lib/agent-connection-config";
import { CREATE_API_TOKEN } from "@/lib/queries";
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

const CLIENTS: { value: AgentClient; label: string; note: string }[] = [
  {
    value: "claude-code",
    label: "Claude Code",
    note:
      "The prompt avoids shell history, but the Claude CLI stores the credential in its MCP config. Keep that config private, never commit it, and revoke the connection when no longer needed.",
  },
  {
    value: "codex",
    label: "Codex",
    note:
      "This config file contains the bearer secret. Use user-only permissions, keep it private, never commit it, and revoke the connection when no longer needed.",
  },
  {
    value: "cursor",
    label: "Cursor",
    note:
      "This config file contains the bearer secret. Use user-only permissions, keep it private, never commit it, and revoke the connection when no longer needed.",
  },
  {
    value: "universal",
    label: "Universal JSON",
    note:
      "This config file contains the bearer secret. Use user-only permissions, keep it private, never commit it, and revoke the connection when no longer needed.",
  },
  {
    value: "graphql",
    label: "GraphQL/cURL",
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
};

type CreateTokenData = {
  createScopedApiToken: CreatedConnection;
};

type PendingExit =
  | { kind: "close" }
  | { kind: "back" }
  | { kind: "link"; href: string };

const HISTORY_GUARD_KEY = "__systemVitalsAgentSecretGuard";
let fallbackGuardSequence = 0;

export function ConnectAgentDialog({
  projectId,
  projectName,
  secondary = false,
}: {
  projectId: string;
  projectName: string;
  secondary?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pendingExit, setPendingExit] = useState<PendingExit | null>(null);
  const [name, setName] = useState(() => `Claude Code — ${projectName}`);
  const [nameEdited, setNameEdited] = useState(false);
  const [expiration, setExpiration] = useState<Expiration>("never");
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
  const [createToken, { loading }] = useMutation<CreateTokenData>(CREATE_API_TOKEN, {
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
        connectionName: created.name,
        apiUrl,
        token: created.plaintext,
        projectId,
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
      setName(`Claude Code — ${projectName}`);
      setNameEdited(false);
      setExpiration("never");
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
      setName(`${CLIENT_LABELS[nextClient]} — ${projectName}`);
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
      projectId,
      ...(expiration === "never" ? {} : { expirationDays: selectedDays }),
    };

    try {
      const result = await createToken({ variables: { input } });
      const connection = result.data?.createScopedApiToken;
      if (!connection) throw new Error("Connection could not be created.");
      setCreated({ plaintext: connection.plaintext, name: connection.name });
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
    router.push("/account/agent-connections");
  }

  return (
    <>
      <Button
        size="sm"
        variant={secondary ? "ghost" : "outline"}
        onClick={() => handleOpenChange(true)}
      >
        <Plug className="mr-1 size-4" />
        Connect agent
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
                    ? "Leave while connection is being created?"
                    : creationUncertain
                      ? "Acknowledge potential connection"
                    : "Discard uncopied token?"}
                </DialogTitle>
                <DialogDescription>
                  {creationPending
                    ? "Creation may finish after you leave, resulting in an active token that has never been shown. Keep this setup open unless you accept losing the one-time secret."
                    : creationUncertain
                      ? "A connection may be active even though its one-time secret was not received. Keep this warning open, acknowledge the risk, then review Agent connections and revoke any potentially created credential."
                    : "You cannot recover this token after closing the setup result."}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" autoFocus onClick={keepResultOpen}>
                  Keep open
                </Button>
                {!creationUncertain && (
                  <Button variant="destructive" onClick={confirmPendingExit}>
                    Discard token
                  </Button>
                )}
              </DialogFooter>
            </>
          ) : creationUncertain ? (
            <div className="space-y-5">
              <div
                role="alert"
                aria-label="Connection status unknown"
                className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
              >
                <p className="font-medium">Connection status unknown</p>
                <p className="mt-1 text-muted-foreground">
                  The creation request did not return a result. A connection may
                  have been created, and the one-time secret was not received.
                  Treat any matching credential as active until you review and
                  revoke it from Agent connections.
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
                  I understand a connection may have been created, and I will
                  review Agent connections to revoke any potentially created
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
                  Review Agent connections
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Connect agent</DialogTitle>
                <DialogDescription>
                  Create a project-scoped connection for{" "}
                  <strong>{projectName}</strong>.
                </DialogDescription>
              </DialogHeader>

              {created ? (
            <div className="space-y-4">
              <div
                role="alert"
                className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
              >
                <p className="font-medium">Save this token now</p>
                <p className="mt-1 text-muted-foreground">
                  It cannot be displayed again. The generated setup contains the
                  secret; avoid commands or workflows that retain it in shell history.
                  Never commit the token or generated config into source control.
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor="agent-token">One-time token</Label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
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
                <pre
                  id="agent-token"
                  className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs"
                >
                  {created.plaintext}
                </pre>
                <div className="flex items-start gap-2 pt-1">
                  <Checkbox
                    id="agent-token-saved"
                    checked={tokenAcknowledged}
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
                    className="space-y-3 pt-3 outline-none"
                  >
                    <p className="text-sm text-muted-foreground">{item.note}</p>
                    <pre className="max-h-56 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
                      {config}
                    </pre>
                  </Tabs.Panel>
                ))}
              </Tabs.Root>

              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Test prompt
                </p>
                <p className="font-mono text-sm">{TEST_PROMPT}</p>
              </div>

              <DialogFooter>
                <Button ref={closeButtonRef} variant="outline" onClick={requestClose}>
                  Close
                </Button>
                <Button onClick={handleSetupCopy}>
                  {setupCopied ? <Check className="mr-1 size-4" /> : <Copy className="mr-1 size-4" />}
                  {setupCopied ? "Setup copied" : "Copy setup"}
                </Button>
              </DialogFooter>
              {copyError !== null && (
                <p
                  role="alert"
                  aria-label="Copy failed"
                  className="text-sm text-destructive"
                >
                  {copyError === "setup"
                    ? "Could not copy the setup. Copy it manually from the configuration above."
                    : "Could not copy the token. Copy it manually from the one-time token above, then confirm that you saved it."}
                </p>
              )}
            </div>
          ) : (
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
              </div>

              <div className="space-y-2">
                <Label htmlFor="agent-name">Connection name</Label>
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
                  Use a name that identifies this agent or environment.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Capabilities</Label>
                <div className="space-y-2 text-sm">
                  <p className="flex gap-2">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                    View checks and recent status.
                  </p>
                  <p className="flex gap-2">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                    Create, edit, pause, resume, and delete checks.
                  </p>
                </div>
                <p className="text-sm text-muted-foreground">
                  Limited to <strong>{projectName}</strong>. No access to
                  organizations, members, billing, notification channels, or other
                  projects.
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
                  {loading ? "Creating…" : "Create connection"}
                </Button>
              </DialogFooter>
            </form>
              )}
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
