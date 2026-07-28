"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@apollo/client/react";
import { Copy, Trash2, UserPlus } from "lucide-react";
import { useOrg } from "@/lib/org-context";
import { useAuth } from "@/lib/auth-context";
import {
  ORGANIZATION_MEMBERS,
  ORGANIZATION_INVITES,
  INVITE_MEMBER,
  REVOKE_INVITE,
  UPDATE_MEMBER_ROLE,
  REMOVE_MEMBER,
} from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Member {
  id: string;
  userId: string;
  email: string;
  role: string;
  createdAt: string;
}

interface Invite {
  id: string;
  email: string;
  role: string;
  token: string;
  acceptUrl: string;
  expiresAt: string;
}

const ROLE_LABELS: Record<string, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
};

const INVITE_ROLE_ITEMS = [
  { value: "MEMBER", label: "Member" },
  { value: "ADMIN", label: "Admin" },
];

const MEMBER_ROLE_ITEMS = [
  { value: "OWNER", label: "Owner" },
  { value: "ADMIN", label: "Admin" },
  { value: "MEMBER", label: "Member" },
];

export default function TeamPage() {
  const { activeOrg, activeOrgId } = useOrg();
  const { refetchMe } = useAuth();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("MEMBER");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const viewerRole = activeOrg?.role ?? "MEMBER";
  const canManage = viewerRole === "OWNER" || viewerRole === "ADMIN";
  const isOwner = viewerRole === "OWNER";

  const vars = { organizationId: activeOrgId ?? "" };
  const skip = !activeOrgId;

  const onError = (e: unknown) => {
    setErrorMessage(
      e instanceof Error ? e.message : "Something went wrong. Please try again.",
    );
  };

  const members = useQuery<{ organizationMembers: Member[] }>(
    ORGANIZATION_MEMBERS,
    { variables: vars, skip },
  );
  const invites = useQuery<{ organizationInvites: Invite[] }>(
    ORGANIZATION_INVITES,
    { variables: vars, skip: skip || !canManage },
  );

  // useQuery in this Apollo version has no onError callback (only useMutation
  // and useSubscription do), so surface query failures through an effect
  // instead. Each effect only re-runs when the underlying error object
  // changes identity -- i.e. once per failed request -- not on every render,
  // so dismissing the dialog cannot immediately retrigger it. Deferred via
  // Promise.resolve().then(...) to satisfy react-hooks/set-state-in-effect.
  useEffect(() => {
    if (members.error) {
      void Promise.resolve().then(() => onError(members.error));
    }
  }, [members.error]);

  useEffect(() => {
    if (invites.error) {
      void Promise.resolve().then(() => onError(invites.error));
    }
  }, [invites.error]);

  const refetchAll = async () => {
    await Promise.all([
      members.refetch(),
      canManage ? invites.refetch() : Promise.resolve(),
      refetchMe(),
    ]);
  };

  const [inviteMember, inviteState] = useMutation(INVITE_MEMBER, {
    onCompleted: () => {
      setEmail("");
      setRole("MEMBER");
      void refetchAll();
    },
    onError,
  });
  const [revokeInvite] = useMutation(REVOKE_INVITE, {
    onCompleted: () => void refetchAll(),
    onError,
  });
  const [updateMemberRole] = useMutation(UPDATE_MEMBER_ROLE, {
    onCompleted: () => void refetchAll(),
    onError,
  });
  const [removeMember] = useMutation(REMOVE_MEMBER, {
    onCompleted: () => void refetchAll(),
    onError,
  });

  async function copyLink(invite: Invite) {
    await navigator.clipboard.writeText(invite.acceptUrl);
    setCopiedId(invite.id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Team</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everyone with access to {activeOrg?.name ?? "this organization"}.
          Available on every plan.
        </p>
      </div>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Invite someone</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-3 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                void inviteMember({
                  variables: { ...vars, email, role },
                });
              }}
            >
              <Input
                type="email"
                required
                value={email}
                aria-label="Email address"
                placeholder="teammate@example.com"
                onChange={(e) => setEmail(e.target.value)}
                className="flex-1"
              />
              {isOwner && (
                <Select
                  items={INVITE_ROLE_ITEMS}
                  value={role}
                  onValueChange={(next) => next && setRole(next)}
                >
                  <SelectTrigger aria-label="Role" className="sm:w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MEMBER">Member</SelectItem>
                    <SelectItem value="ADMIN">Admin</SelectItem>
                  </SelectContent>
                </Select>
              )}
              <Button type="submit" disabled={inviteState.loading}>
                <UserPlus className="mr-2 h-4 w-4" />
                {inviteState.loading ? "Sending…" : "Send invite"}
              </Button>
            </form>
            <p className="mt-3 text-xs text-muted-foreground">
              We email the invite, and you can also copy the link below and send
              it yourself.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Members</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {members.loading && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {members.data?.organizationMembers.map((m) => (
            <div
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            >
              <span className="text-sm">{m.email}</span>
              <div className="flex items-center gap-2">
                {isOwner ? (
                  <Select
                    items={MEMBER_ROLE_ITEMS}
                    value={m.role}
                    onValueChange={(next) =>
                      next &&
                      void updateMemberRole({
                        variables: { membershipId: m.id, role: next },
                      })
                    }
                  >
                    <SelectTrigger
                      aria-label={`Role for ${m.email}`}
                      className="w-32"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="OWNER">Owner</SelectItem>
                      <SelectItem value="ADMIN">Admin</SelectItem>
                      <SelectItem value="MEMBER">Member</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {ROLE_LABELS[m.role] ?? m.role}
                  </span>
                )}
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${m.email}`}
                    onClick={() =>
                      void removeMember({ variables: { membershipId: m.id } })
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {canManage && (invites.data?.organizationInvites.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending invites</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {invites.data?.organizationInvites.map((i) => (
              <div
                key={i.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div>
                  <p className="text-sm">{i.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {ROLE_LABELS[i.role] ?? i.role} · expires{" "}
                    {new Date(i.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void copyLink(i)}
                  >
                    <Copy className="mr-2 h-4 w-4" />
                    {copiedId === i.id ? "Copied" : "Copy link"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Revoke invite for ${i.email}`}
                    onClick={() =>
                      void revokeInvite({ variables: { inviteId: i.id } })
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={!!errorMessage} onOpenChange={() => setErrorMessage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Something went wrong</DialogTitle>
            <DialogDescription>{errorMessage}</DialogDescription>
          </DialogHeader>
          <Button onClick={() => setErrorMessage(null)}>Dismiss</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
