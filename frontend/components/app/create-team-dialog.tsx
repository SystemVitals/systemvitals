"use client";

import { useState } from "react";
import { useMutation } from "@apollo/client/react";
import { Plus } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { CREATE_ORGANIZATION } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Self-contained "New organization" button + dialog. On success it refreshes the
 * auth context (so the switcher and org list update) and makes the new org
 * active. Rendered both on /organizations and in the sidebar org switcher —
 * the single source of the create flow, so the two entry points cannot drift.
 */
export function CreateTeamDialog({
  variant = "default",
  className,
}: {
  variant?: "default" | "ghost";
  className?: string;
}) {
  const { refetchMe } = useAuth();
  const { setActiveOrgId } = useOrg();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorTitle, setErrorTitle] = useState("Couldn't create the organization");

  const [createOrganization, { loading }] = useMutation(CREATE_ORGANIZATION, {
    onError: (e) => {
      setErrorTitle("Couldn't create the organization");
      setErrorMessage(e.message);
    },
  });

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    let created: { id: string } | undefined;
    try {
      const res = await createOrganization({ variables: { name } });
      created = (
        res.data as { createOrganization?: { id: string } } | null
      )?.createOrganization;
    } catch {
      // Surfaced via the mutation's onError → error dialog.
      return;
    }
    if (created) {
      setActiveOrgId(created.id);
      setOpen(false);
      setName("");
      try {
        await refetchMe();
      } catch (error) {
        setErrorTitle("Organization created, but refresh failed");
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "The organization was created, but the organization list could not be refreshed.",
        );
      }
    }
  }

  return (
    <>
      <Button
        variant={variant}
        size="sm"
        className={className}
        onClick={() => setOpen(true)}
      >
        <Plus className="mr-2 h-4 w-4" />
        New organization
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create an organization</DialogTitle>
            <DialogDescription>
              A separate workspace with its own checks, channels, status pages,
              and members. You&apos;ll be the owner, and its checks count toward
              your account&apos;s plan.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="create-team-name">Organization name</Label>
              <Input
                id="create-team-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Inc."
                required
              />
            </div>
            <Button type="submit" disabled={loading || !name.trim()}>
              {loading ? "Creating…" : "Create organization"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!errorMessage} onOpenChange={() => setErrorMessage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{errorTitle}</DialogTitle>
            <DialogDescription>{errorMessage}</DialogDescription>
          </DialogHeader>
          <Button onClick={() => setErrorMessage(null)}>Dismiss</Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
