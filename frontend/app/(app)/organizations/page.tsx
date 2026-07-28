"use client";

import { useState } from "react";
import { useMutation } from "@apollo/client/react";
import { Pencil, Trash2, LogOut } from "lucide-react";
import { useAuth, type Org } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { CreateTeamDialog } from "@/components/app/create-team-dialog";
import { TransferCreatorshipDialog } from "@/components/app/transfer-creatorship-dialog";
import {
  UPDATE_ORGANIZATION,
  UPDATE_ORGANIZATION_SLUG,
  DELETE_ORGANIZATION,
  LEAVE_ORGANIZATION,
} from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
};

export default function OrganizationsPage() {
  const { user, refetchMe } = useAuth();
  const { orgs } = useOrg();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onError = (e: unknown) =>
    setErrorMessage(e instanceof Error ? e.message : "Something went wrong.");
  const refresh = () => refetchMe().catch(onError);

  const [updateOrganization] = useMutation(UPDATE_ORGANIZATION, {
    onCompleted: refresh,
    onError,
  });
  const [updateOrganizationSlug] = useMutation(UPDATE_ORGANIZATION_SLUG, {
    onCompleted: refresh,
    onError,
  });
  const [deleteOrganization] = useMutation(DELETE_ORGANIZATION, {
    onCompleted: refresh,
    onError,
  });
  const [leaveOrganization] = useMutation(LEAVE_ORGANIZATION, {
    onCompleted: refresh,
    onError,
  });

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Organizations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            SOLO accounts can create or own up to 10 organizations attributed
            to their account. SIGNAL and FLEET accounts have no limit.
          </p>
        </div>
        <CreateTeamDialog />
      </div>

      <div className="space-y-3">
        {orgs.map((org) => (
          <OrgRow
            key={org.id}
            org={org}
            isLast={orgs.length <= 1}
            currentUserId={user?.id ?? ""}
            onTransferred={refetchMe}
            onRename={(name) =>
              void updateOrganization({
                variables: { organizationId: org.id, name },
              }).catch(() => {})
            }
            onReslug={(slug) =>
              void updateOrganizationSlug({
                variables: { organizationId: org.id, slug },
              }).catch(() => {})
            }
            onDelete={() =>
              void deleteOrganization({
                variables: { organizationId: org.id },
              }).catch(() => {})
            }
            onLeave={() =>
              void leaveOrganization({
                variables: { organizationId: org.id },
              }).catch(() => {})
            }
          />
        ))}
      </div>

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

function OrgRow({
  org,
  isLast,
  currentUserId,
  onTransferred,
  onRename,
  onReslug,
  onDelete,
  onLeave,
}: {
  org: Org;
  isLast: boolean;
  currentUserId: string;
  onTransferred: () => Promise<unknown>;
  onRename: (name: string) => void;
  onReslug: (slug: string) => void;
  onDelete: () => void;
  onLeave: () => void;
}) {
  const canManage = org.role === "OWNER" || org.role === "ADMIN";
  const isOwner = org.role === "OWNER";
  const isCreator = currentUserId === org.creatorUserId;

  const [editOpen, setEditOpen] = useState(false);
  const [name, setName] = useState(org.name);
  const [slug, setSlug] = useState(org.slug);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [leaveOpen, setLeaveOpen] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="text-base">{org.name}</CardTitle>
          <p className="text-xs text-muted-foreground">
            /{org.slug} · {ROLE_LABEL[org.role] ?? org.role}
          </p>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 break-words">
              {isCreator
                ? "Inherited from your account"
                : `Inherited from ${org.creatorLabel}`}
            </span>
            <Badge variant="secondary">{org.plan}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
          {isCreator && (
            <TransferCreatorshipDialog
              organization={org}
              currentUserId={currentUserId}
              onTransferred={onTransferred}
            />
          )}
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              aria-label={`Edit ${org.name}`}
              onClick={() => setEditOpen(true)}
            >
              <Pencil className="mr-2 h-4 w-4" />
              Edit
            </Button>
          )}
          {isOwner && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${org.name}`}
              disabled={isLast}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          {!isOwner && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Leave ${org.name}`}
              onClick={() => setLeaveOpen(true)}
            >
              <LogOut className="mr-2 h-4 w-4" />
              Leave
            </Button>
          )}
        </div>
      </CardHeader>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {org.name}</DialogTitle>
            <DialogDescription>
              Renaming the slug changes every check URL in this org — the old
              URLs stop working immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`name-${org.id}`}>Name</Label>
              <Input
                id={`name-${org.id}`}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Button
                size="sm"
                disabled={!name.trim() || name.trim() === org.name}
                onClick={() => onRename(name.trim())}
              >
                Save name
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`slug-${org.id}`}>Slug</Label>
              <Input
                id={`slug-${org.id}`}
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
              />
              <Button
                size="sm"
                disabled={!slug.trim() || slug.trim() === org.slug}
                onClick={() => onReslug(slug.trim())}
              >
                Save slug
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave {org.name}?</DialogTitle>
            <DialogDescription>
              You will lose access to {org.name} and its projects, checks, and
              history. You&apos;ll need a new invitation to regain access.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setLeaveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                onLeave();
                setLeaveOpen(false);
              }}
            >
              Confirm leave
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {org.name}?</DialogTitle>
            <DialogDescription>
              This permanently deletes all of {org.name}&apos;s projects, checks,
              and history. Account billing is unaffected. Manage billing
              separately. This cannot be undone. Type the organization name to
              confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              aria-label="Confirm organization name"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={org.name}
            />
            <Button
              variant="destructive"
              disabled={confirmName !== org.name}
              onClick={() => {
                onDelete();
                setDeleteOpen(false);
              }}
            >
              Delete organization
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
