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
 * Self-contained "Create team" button + dialog. On success it refreshes the
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
  const [errorTitle, setErrorTitle] = useState("Couldn't create the team");

  const [createOrganization, { loading }] = useMutation(CREATE_ORGANIZATION, {
    onError: (e) => {
      setErrorTitle("Couldn't create the team");
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
        setErrorTitle("Team created, but refresh failed");
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "The team was created, but the team list could not be refreshed.",
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
        Create team
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a team</DialogTitle>
            <DialogDescription>
              You&apos;ll be the owner. It starts on the free plan.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="create-team-name">Team name</Label>
              <Input
                id="create-team-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <Button type="submit" disabled={loading || !name.trim()}>
              {loading ? "Creating…" : "Create"}
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
