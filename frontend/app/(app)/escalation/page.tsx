"use client";
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@apollo/client/react";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import {
  ESCALATION_POLICIES,
  CREATE_ESCALATION_POLICY,
  UPDATE_ESCALATION_POLICY,
  DELETE_ESCALATION_POLICY,
  CHANNELS,
} from "@/lib/queries";
import { buildEscalationStepsJson, type EscalationStep } from "@/lib/escalation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";

interface PolicyStep {
  channelId: string;
  delaySeconds: number;
}

interface EscalationPolicy {
  id: string;
  steps: PolicyStep[];
}

interface Channel {
  id: string;
  type: string;
  configJson: string;
  enabled: boolean;
}

interface EditorStep {
  /** local key for React list rendering */
  key: number;
  channelId: string;
  delayMinutes: string;
}

function channelLabel(ch: Channel): string {
  try {
    const cfg = JSON.parse(ch.configJson) as Record<string, string>;
    const detail =
      cfg["email"] ??
      cfg["chatId"] ??
      cfg["url"] ??
      cfg["webhookUrl"] ??
      "";
    const typeLabel: Record<string, string> = {
      EMAIL: "Email",
      SLACK: "Slack",
      TELEGRAM: "Telegram",
      WEBHOOK: "Webhook",
    };
    const label = typeLabel[ch.type] ?? ch.type;
    return detail ? `${label}: ${detail}` : label;
  } catch {
    return ch.id;
  }
}

interface PolicyEditorProps {
  projectId: string;
}

function PolicyEditor({ projectId }: PolicyEditorProps) {
  const _keySeq = useRef(0);
  function nextKey() {
    return ++_keySeq.current;
  }
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Editor steps (local draft)
  const [editorSteps, setEditorSteps] = useState<EditorStep[]>([]);
  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);

  const {
    data: policiesData,
    refetch: refetchPolicies,
    loading: policiesLoading,
    error: policiesError,
  } = useQuery<{ escalationPolicies: EscalationPolicy[] }>(ESCALATION_POLICIES, {
    variables: { projectId },
  });

  const {
    data: channelsData,
    loading: channelsLoading,
    error: channelsError,
  } = useQuery<{ channels: Channel[] }>(CHANNELS, {
    variables: { projectId },
  });

  const [createPolicy, { loading: creating, error: createError }] = useMutation(
    CREATE_ESCALATION_POLICY,
    { onCompleted: () => refetchPolicies() }
  );

  const [updatePolicy, { loading: updating, error: updateError }] = useMutation(
    UPDATE_ESCALATION_POLICY,
    { onCompleted: () => refetchPolicies() }
  );

  const [deletePolicy, { error: deleteError }] = useMutation(
    DELETE_ESCALATION_POLICY,
    {
      onCompleted: () => {
        setConfirmDeleteId(null);
        setEditingPolicyId(null);
        setEditorSteps([]);
        refetchPolicies();
      },
    }
  );

  // Propagate query/mutation errors to dialog
  useEffect(() => {
    if (policiesError) Promise.resolve().then(() => setErrorMessage(policiesError.message));
  }, [policiesError]);

  useEffect(() => {
    if (channelsError) Promise.resolve().then(() => setErrorMessage(channelsError.message));
  }, [channelsError]);

  useEffect(() => {
    if (createError) Promise.resolve().then(() => setErrorMessage(createError.message));
  }, [createError]);

  useEffect(() => {
    if (updateError) Promise.resolve().then(() => setErrorMessage(updateError.message));
  }, [updateError]);

  useEffect(() => {
    if (deleteError) {
      Promise.resolve().then(() => {
        setConfirmDeleteId(null);
        setErrorMessage(deleteError.message);
      });
    }
  }, [deleteError]);

  const policies = policiesData?.escalationPolicies ?? [];
  const channels = channelsData?.channels ?? [];

  // Load an existing policy into the editor
  function loadPolicy(policy: EscalationPolicy) {
    setEditingPolicyId(policy.id);
    setEditorSteps(
      policy.steps.map((s) => ({
        key: nextKey(),
        channelId: s.channelId,
        delayMinutes: String(Math.round(s.delaySeconds / 60)),
      }))
    );
  }

  function addStep() {
    const firstChannelId = channels[0]?.id ?? "";
    setEditorSteps((prev) => [
      ...prev,
      { key: nextKey(), channelId: firstChannelId, delayMinutes: "5" },
    ]);
  }

  function removeStep(key: number) {
    setEditorSteps((prev) => prev.filter((s) => s.key !== key));
  }

  function updateStep(key: number, field: keyof Omit<EditorStep, "key">, value: string) {
    setEditorSteps((prev) =>
      prev.map((s) => (s.key === key ? { ...s, [field]: value } : s))
    );
  }

  async function handleSave() {
    setErrorMessage(null);
    // Validate
    for (const step of editorSteps) {
      if (!step.channelId) {
        setErrorMessage("Each step must have a channel selected.");
        return;
      }
      const mins = parseFloat(step.delayMinutes);
      if (isNaN(mins) || mins < 0) {
        setErrorMessage("Delay must be a non-negative number.");
        return;
      }
    }

    const steps: EscalationStep[] = editorSteps.map((s) => ({
      channelId: s.channelId,
      delaySeconds: Math.round(parseFloat(s.delayMinutes) * 60),
    }));
    const stepsJson = buildEscalationStepsJson(steps);

    if (editingPolicyId) {
      await updatePolicy({ variables: { id: editingPolicyId, stepsJson } });
    } else {
      await createPolicy({ variables: { projectId, stepsJson } });
    }
  }

  const isBusy = policiesLoading || channelsLoading || creating || updating;
  const hasExistingPolicy = policies.length > 0;

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        {policiesLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}

        {!policiesLoading && policies.length === 0 && (
          <p className="text-sm text-muted-foreground">No escalation policy yet.</p>
        )}

        {policies.map((policy) => (
          <Card key={policy.id} className="mb-4">
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">
                  Policy — {policy.steps.length} step{policy.steps.length !== 1 ? "s" : ""}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => loadPolicy(policy)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setConfirmDeleteId(policy.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {policy.steps.length > 0 && (
                <ol className="space-y-1 text-sm list-decimal list-inside">
                  {policy.steps.map((step, idx) => {
                    const ch = channels.find((c) => c.id === step.channelId);
                    const label = ch ? channelLabel(ch) : step.channelId;
                    const mins = Math.round(step.delaySeconds / 60);
                    return (
                      <li key={idx} className="text-muted-foreground">
                        <span className="text-foreground font-medium">{label}</span>
                        {" — after "}
                        <span className="font-medium">{mins} min</span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Editor card */}
      {(!hasExistingPolicy || editingPolicyId !== null) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              {editingPolicyId ? "Edit policy" : "New escalation policy"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {channelsLoading && (
              <p className="text-sm text-muted-foreground">Loading channels…</p>
            )}

            {!channelsLoading && channels.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No channels available. Add channels first.
              </p>
            )}

            {editorSteps.length === 0 && !channelsLoading && channels.length > 0 && (
              <p className="text-sm text-muted-foreground">
                No steps yet. Add a step to define the escalation sequence.
              </p>
            )}

            {editorSteps.map((step, idx) => (
              <div key={step.key} className="flex items-center gap-2">
                <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-muted text-muted-foreground text-xs font-medium shrink-0">
                  {idx + 1}
                </span>

                {/* Channel picker */}
                <div className="flex-1 min-w-0">
                  <Label htmlFor={`channel-${step.key}`} className="sr-only">
                    Channel
                  </Label>
                  <Select
                    value={step.channelId}
                    onValueChange={(v) => { if (v !== null) updateStep(step.key, "channelId", v); }}
                  >
                    <SelectTrigger id={`channel-${step.key}`}>
                      <SelectValue placeholder="Pick a channel" />
                    </SelectTrigger>
                    <SelectContent>
                      {channels.map((ch) => (
                        <SelectItem key={ch.id} value={ch.id}>
                          {channelLabel(ch)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Delay */}
                <div className="flex items-center gap-1 shrink-0 w-36">
                  <Label htmlFor={`delay-${step.key}`} className="sr-only">
                    Delay (minutes)
                  </Label>
                  <Input
                    id={`delay-${step.key}`}
                    type="number"
                    min="0"
                    step="1"
                    placeholder="5"
                    value={step.delayMinutes}
                    onChange={(e) => updateStep(step.key, "delayMinutes", e.target.value)}
                    className="w-20"
                  />
                  <span className="text-xs text-muted-foreground">min</span>
                </div>

                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive hover:text-destructive shrink-0"
                  onClick={() => removeStep(step.key)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}

            <div className="flex gap-2">
              {channels.length > 0 && (
                <Button variant="outline" size="sm" onClick={addStep}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add step
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleSave}
                disabled={isBusy || channels.length === 0}
              >
                {creating || updating ? "Saving…" : editingPolicyId ? "Update policy" : "Create policy"}
              </Button>
              {editingPolicyId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditingPolicyId(null);
                    setEditorSteps([]);
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Confirm delete dialog */}
      <Dialog
        open={!!confirmDeleteId}
        onOpenChange={(open: boolean) => { if (!open) setConfirmDeleteId(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete escalation policy?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This policy and all its steps will be removed. This cannot be undone.
          </p>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setConfirmDeleteId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmDeleteId) {
                  deletePolicy({ variables: { id: confirmDeleteId } });
                }
              }}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Error dialog */}
      <Dialog open={!!errorMessage} onOpenChange={() => setErrorMessage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Error</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{errorMessage}</p>
          <Button onClick={() => setErrorMessage(null)}>Dismiss</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function EscalationPage() {
  const { user } = useAuth();
  const { activeOrg } = useOrg();

  if (!user) return null;

  const firstProject = activeOrg?.projects[0];

  return (
    <div className="px-4 py-6 sm:px-6 space-y-6">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Escalation Policies</h1>
        <p className="text-sm text-muted-foreground mt-1">Define multi-step alert escalation sequences for your project.</p>
      </div>

      {!firstProject ? (
        <p className="text-muted-foreground">No projects found.</p>
      ) : (
        <PolicyEditor projectId={firstProject.id} />
      )}
    </div>
  );
}
