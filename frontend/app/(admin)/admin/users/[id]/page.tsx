"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation } from "@apollo/client/react";
import Link from "next/link";
import { ArrowLeft, Shield, ShieldOff, UserX, Trash2, Building2, UserCheck } from "lucide-react";
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
  ADMIN_USER,
  ADMIN_SUSPEND_USER,
  ADMIN_UNSUSPEND_USER,
  ADMIN_SET_USER_ADMIN,
  ADMIN_DELETE_USER,
  ADMIN_IMPERSONATE,
} from "@/lib/admin-queries";
import { cn } from "@/lib/utils";
import { AdminUser } from "@/lib/admin-types";

type ConfirmAction = "suspend" | "unsuspend" | "grant-admin" | "revoke-admin" | "delete" | "impersonate" | null;

const CONFIRM_LABELS: Record<NonNullable<ConfirmAction>, { title: string; description: string; confirmLabel: string; destructive?: boolean }> = {
  suspend: {
    title: "Suspend user",
    description: "This will prevent the user from logging in. You can unsuspend them later.",
    confirmLabel: "Suspend",
    destructive: true,
  },
  unsuspend: {
    title: "Unsuspend user",
    description: "This will restore the user's access to the platform.",
    confirmLabel: "Unsuspend",
  },
  "grant-admin": {
    title: "Grant admin access",
    description: "This user will have full admin access to the back-office. Proceed only if you trust this user.",
    confirmLabel: "Grant admin",
    destructive: true,
  },
  "revoke-admin": {
    title: "Revoke admin access",
    description: "This user will lose their admin access to the back-office.",
    confirmLabel: "Revoke admin",
    destructive: true,
  },
  delete: {
    title: "Delete user",
    description: "This is permanent. Organization creators must transfer creatorship first. Account holders must finish or resolve checkout and cancel paid billing before deletion.",
    confirmLabel: "Delete permanently",
    destructive: true,
  },
  impersonate: {
    title: "Impersonate user",
    description: "You will be logged in as this user for 30 minutes. Your current session is saved and can be restored.",
    confirmLabel: "Impersonate",
  },
};

export default function AdminUserDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data, loading, error } = useQuery<{ adminUser: AdminUser | null }>(ADMIN_USER, {
    variables: { id },
    fetchPolicy: "cache-and-network",
  });

  const [suspendUser, { loading: suspending }] = useMutation(ADMIN_SUSPEND_USER);
  const [unsuspendUser, { loading: unsuspending }] = useMutation(ADMIN_UNSUSPEND_USER);
  const [setUserAdmin, { loading: settingAdmin }] = useMutation(ADMIN_SET_USER_ADMIN);
  const [deleteUser, { loading: deleting }] = useMutation(ADMIN_DELETE_USER);
  const [impersonateUser, { loading: impersonating }] = useMutation<{
    adminImpersonate: { token: string; expiresAt: string };
  }>(ADMIN_IMPERSONATE);

  const user = data?.adminUser;

  const handleConfirm = async () => {
    if (!confirmAction || !user) return;
    try {
      if (confirmAction === "suspend") {
        await suspendUser({ variables: { id: user.id } });
      } else if (confirmAction === "unsuspend") {
        await unsuspendUser({ variables: { id: user.id } });
      } else if (confirmAction === "grant-admin") {
        await setUserAdmin({ variables: { id: user.id, isAdmin: true } });
      } else if (confirmAction === "revoke-admin") {
        await setUserAdmin({ variables: { id: user.id, isAdmin: false } });
      } else if (confirmAction === "delete") {
        await deleteUser({ variables: { id: user.id } });
        setConfirmAction(null);
        router.push("/admin/users");
        return;
      } else if (confirmAction === "impersonate") {
        const result = await impersonateUser({ variables: { userId: user.id } });
        const token = result.data?.adminImpersonate.token;
        if (!token) throw new Error("No impersonation token returned.");
        const currentToken = localStorage.getItem("sv_token");
        if (currentToken) {
          localStorage.setItem("sv_admin_token", currentToken);
        }
        localStorage.setItem("sv_token", token);
        setConfirmAction(null);
        window.location.assign("/dashboard");
        return;
      }
      setConfirmAction(null);
    } catch (err) {
      setConfirmAction(null);
      setErrorMessage(err instanceof Error ? err.message : "An unexpected error occurred.");
    }
  };

  if (loading && !data) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>;
  }

  if (error) {
    return <p className="text-sm text-destructive py-4">Error loading user: {error.message}</p>;
  }

  if (!user) {
    return <p className="text-sm text-muted-foreground py-8 text-center">User not found.</p>;
  }

  const confirmMeta = confirmAction ? CONFIRM_LABELS[confirmAction] : null;

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/admin/users"
          className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="sr-only">Back to users</span>
        </Link>
        <h1 className="font-heading text-2xl font-semibold tracking-tight truncate">{user.email}</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* User info */}
        <Card>
          <CardHeader>
            <CardTitle>User details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Email</p>
              <p className="text-sm mt-0.5">{user.email}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Status</p>
              <div className="flex items-center gap-2 mt-1">
                {user.suspendedAt ? (
                  <span className="inline-flex items-center rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive">
                    Suspended
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success">
                    Active
                  </span>
                )}
                {user.isAdmin && (
                  <span className="inline-flex items-center rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                    Admin
                  </span>
                )}
              </div>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Joined</p>
              <p className="text-sm mt-0.5">{new Date(user.createdAt).toLocaleString()}</p>
            </div>
            {user.suspendedAt && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Suspended at</p>
                <p className="text-sm mt-0.5">{new Date(user.suspendedAt).toLocaleString()}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Actions */}
        <Card>
          <CardHeader>
            <CardTitle>Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {user.suspendedAt ? (
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                disabled={unsuspending}
                onClick={() => setConfirmAction("unsuspend")}
              >
                <Shield className="h-4 w-4 text-success" />
                Unsuspend user
              </Button>
            ) : (
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                disabled={suspending}
                onClick={() => setConfirmAction("suspend")}
              >
                <UserX className="h-4 w-4 text-warning" />
                Suspend user
              </Button>
            )}

            {user.isAdmin ? (
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                disabled={settingAdmin}
                onClick={() => setConfirmAction("revoke-admin")}
              >
                <ShieldOff className="h-4 w-4 text-destructive" />
                Revoke admin
              </Button>
            ) : (
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                disabled={settingAdmin}
                onClick={() => setConfirmAction("grant-admin")}
              >
                <Shield className="h-4 w-4 text-primary" />
                Grant admin
              </Button>
            )}

            <Button
              variant="outline"
              className="w-full justify-start gap-2"
              disabled={impersonating}
              onClick={() => setConfirmAction("impersonate")}
            >
              <UserCheck className="h-4 w-4 text-primary" />
              Impersonate user
            </Button>

            <Button
              variant="destructive"
              className="w-full justify-start gap-2"
              disabled={deleting}
              onClick={() => setConfirmAction("delete")}
            >
              <Trash2 className="h-4 w-4" />
              Delete user
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Organizations */}
      {user.organizations.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Organizations</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {user.organizations.map((org) => (
                <div key={org.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
                  <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{org.name}</p>
                    <p className="text-xs text-muted-foreground capitalize">{org.role.toLowerCase()}</p>
                  </div>
                  <Link
                    href={`/admin/organizations/${org.id}`}
                    className={cn(buttonVariants({ variant: "ghost", size: "xs" }))}
                  >
                    View org
                  </Link>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {user.organizations.length === 0 && (
        <Card className="mt-4">
          <CardContent className="py-6">
            <p className="text-sm text-muted-foreground text-center">No organizations.</p>
          </CardContent>
        </Card>
      )}

      {/* Confirm dialog */}
      <Dialog open={!!confirmAction} onOpenChange={(open) => { if (!open) setConfirmAction(null); }}>
        <DialogContent>
          {confirmMeta && (
            <>
              <DialogHeader>
                <DialogTitle>{confirmMeta.title}</DialogTitle>
                <DialogDescription>{confirmMeta.description}</DialogDescription>
              </DialogHeader>
              <DialogFooter showCloseButton>
                {(() => {
                  const isActionLoading =
                    (confirmAction === "suspend" && suspending) ||
                    (confirmAction === "unsuspend" && unsuspending) ||
                    ((confirmAction === "grant-admin" || confirmAction === "revoke-admin") && settingAdmin) ||
                    (confirmAction === "delete" && deleting) ||
                    (confirmAction === "impersonate" && impersonating);
                  return (
                    <Button
                      variant={confirmMeta.destructive ? "destructive" : "default"}
                      disabled={isActionLoading}
                      onClick={handleConfirm}
                    >
                      {isActionLoading ? "Working…" : confirmMeta.confirmLabel}
                    </Button>
                  );
                })()}
              </DialogFooter>
            </>
          )}
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
