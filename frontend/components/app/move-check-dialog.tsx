"use client";

import { useState } from "react";
import { flushSync } from "react-dom";
import { useApolloClient, useMutation } from "@apollo/client/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOrg } from "@/lib/org-context";
import { MOVE_CHECK } from "@/lib/queries";

export interface MoveDestination {
  organizationId: string;
  organizationSlug: string;
  checkSlug: string;
}

interface MoveCheckDialogProps {
  checkId: string;
  sourceOrganizationId: string;
  checkSlug: string;
  onMoved: (destination: MoveDestination) => void;
}

export function MoveCheckDialog({
  checkId,
  sourceOrganizationId,
  checkSlug,
  onMoved,
}: MoveCheckDialogProps) {
  const client = useApolloClient();
  const { orgs } = useOrg();
  const [open, setOpen] = useState(false);
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [moveCheck, { loading }] = useMutation<
    { moveCheck: { id: string; organizationId: string; slug: string } },
    { checkId: string; destinationOrganizationId: string }
  >(MOVE_CHECK);

  const sourceOrg = orgs.find((org) => org.id === sourceOrganizationId);
  const destinationOrgs = orgs.filter(
    (org) =>
      org.role === "OWNER" &&
      org.id !== sourceOrganizationId,
  );
  const selectedOrg = destinationOrgs.find((org) => org.id === selectedOrgId);

  if (
    !sourceOrg ||
    sourceOrg.role !== "OWNER" ||
    destinationOrgs.length === 0
  ) {
    return null;
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setSelectedOrgId("");
      setErrorMessage(null);
    }
    setOpen(nextOpen);
  }

  function handleOrganizationChange(organizationId: string | null) {
    setSelectedOrgId(organizationId ?? "");
    setErrorMessage(null);
  }

  async function handleMove() {
    if (!selectedOrg) return;

    setErrorMessage(null);
    let movedCheck: { id: string; organizationId: string; slug: string };
    try {
      const result = await moveCheck({
        variables: {
          checkId,
          destinationOrganizationId: selectedOrg.id,
        },
      });
      if (!result.data?.moveCheck) {
        throw new Error("Move check returned no check");
      }
      movedCheck = result.data.moveCheck;
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to move check.",
      );
      return;
    }

    try {
      client.cache.evict({ id: "ROOT_QUERY", fieldName: "checks" });
      client.cache.evict({ id: "ROOT_QUERY", fieldName: "statusPages" });
      client.cache.gc();
    } catch {
      // The server mutation is already committed; cache cleanup is best-effort.
    }

    flushSync(() => setOpen(false));
    try {
      onMoved({
        organizationId: selectedOrg.id,
        organizationSlug: selectedOrg.slug,
        checkSlug: movedCheck.slug,
      });
    } catch {
      // A navigation callback cannot roll back a completed server mutation.
    }

    void client
      .refetchQueries({ include: ["checks", "statusPages"] })
      .catch(() => undefined);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button variant="outline" />}>
        Move check
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move check</DialogTitle>
          <DialogDescription>
            Choose the organization that should own this check.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <Select value={selectedOrgId} onValueChange={handleOrganizationChange}>
            <SelectTrigger className="w-full" aria-label="Destination organization">
              <SelectValue placeholder="Select organization">
                {selectedOrg?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {destinationOrgs.map((org) => (
                <SelectItem key={org.id} value={org.id}>
                  {org.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {selectedOrg && (
            <p className="font-mono text-sm text-muted-foreground">
              /{selectedOrg.slug}/{checkSlug}
            </p>
          )}

          {errorMessage && (
            <p className="text-sm text-destructive" role="alert">
              {errorMessage}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            onClick={handleMove}
            disabled={!selectedOrg || loading}
          >
            {loading ? "Moving…" : "Move check"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
