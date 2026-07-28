"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation } from "@apollo/client/react";
import Link from "next/link";
import { ArrowLeft, Trash2, Users, Layers } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ADMIN_ORGANIZATION,
  ADMIN_DELETE_ORGANIZATION,
} from "@/lib/admin-queries";
import { cn } from "@/lib/utils";
import { AdminOrganization, planBadgeClass } from "@/lib/admin-types";

export default function AdminOrganizationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data, loading, error } = useQuery<{ adminOrganization: AdminOrganization | null }>(
    ADMIN_ORGANIZATION,
    {
      variables: { id },
      fetchPolicy: "cache-and-network",
    }
  );

  const [deleteOrganization, { loading: deleting }] = useMutation(ADMIN_DELETE_ORGANIZATION);

  const org = data?.adminOrganization;

  const handleDelete = async () => {
    if (!org) return;
    try {
      await deleteOrganization({ variables: { id: org.id } });
      setShowDeleteConfirm(false);
      router.push("/admin/organizations");
    } catch (err) {
      setShowDeleteConfirm(false);
      setErrorMessage(err instanceof Error ? err.message : "An unexpected error occurred.");
    }
  };

  if (loading && !data) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>;
  }

  if (error) {
    return <p className="text-sm text-destructive py-4">Error loading organization: {error.message}</p>;
  }

  if (!org) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Organization not found.</p>;
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/admin/organizations"
          className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="sr-only">Back to organizations</span>
        </Link>
        <h1 className="font-heading text-2xl font-semibold tracking-tight truncate">{org.name}</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Org info */}
        <Card>
          <CardHeader>
            <CardTitle>Organization details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Name</p>
              <p className="text-sm mt-0.5">{org.name}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Plan</p>
              <div className="mt-1">
                <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", planBadgeClass(org.plan))}>
                  {org.plan}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Inherited from the creator account.
              </p>
              <Link
                href="/admin/subscriptions"
                className="mt-1 inline-block text-xs text-primary hover:underline"
              >
                Manage account subscriptions
              </Link>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Created</p>
              <p className="text-sm mt-0.5">{new Date(org.createdAt).toLocaleString()}</p>
            </div>
            <div className="flex gap-6">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Projects</p>
                <div className="flex items-center gap-1.5 mt-1">
                  <Layers className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium">{org.projectCount}</p>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Members</p>
                <div className="flex items-center gap-1.5 mt-1">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium">{org.members.length}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Actions */}
        <Card>
          <CardHeader>
            <CardTitle>Actions</CardTitle>
          </CardHeader>
          <CardContent>
            <Button
              variant="destructive"
              className="w-full justify-start gap-2"
              disabled={deleting}
              onClick={() => setShowDeleteConfirm(true)}
            >
              <Trash2 className="h-4 w-4" />
              Delete organization
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              Permanently deletes the organization and all associated data. This cannot be undone.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Members */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Members ({org.members.length})</CardTitle>
        </CardHeader>
        {org.members.length === 0 ? (
          <CardContent>
            <p className="text-sm text-muted-foreground text-center py-4">No members.</p>
          </CardContent>
        ) : (
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {org.members.map((member) => (
                <div
                  key={member.userId}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{member.email}</p>
                    <p className="text-xs text-muted-foreground capitalize">{member.role.toLowerCase()}</p>
                  </div>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      member.role === "OWNER"
                        ? "bg-success/15 text-success"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {member.role}
                  </span>
                  <Link
                    href={`/admin/users/${member.userId}`}
                    className={cn(buttonVariants({ variant: "ghost", size: "xs" }))}
                  >
                    View user
                  </Link>
                </div>
              ))}
            </div>
          </CardContent>
        )}
      </Card>

      {/* Delete confirm dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={(open) => { if (!open) setShowDeleteConfirm(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete organization</DialogTitle>
            <DialogDescription>
              This will permanently delete <strong>{org.name}</strong> and all associated projects, checks, and data. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={handleDelete}
            >
              {deleting ? "Deleting…" : "Delete permanently"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Error dialog */}
      <Dialog open={!!errorMessage} onOpenChange={(open) => { if (!open) setErrorMessage(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Error</DialogTitle>
            <DialogDescription>{errorMessage}</DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </div>
  );
}
