"use client";

import { useState } from "react";
import { useLazyQuery, useMutation } from "@apollo/client/react";
import { ArrowRightLeft } from "lucide-react";
import type { Org } from "@/lib/auth-context";
import {
  ORGANIZATION_MEMBERS,
  TRANSFER_ORGANIZATION_CREATORSHIP,
} from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

interface TransferCreatorshipDialogProps {
  organization: Org;
  currentUserId: string;
  onTransferred: () => Promise<unknown>;
}

interface Member {
  userId: string;
  email: string;
  role: string;
}

export function TransferCreatorshipDialog({
  organization,
  currentUserId,
  onTransferred,
}: TransferCreatorshipDialogProps) {
  const [open, setOpen] = useState(false);
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [transferCompleted, setTransferCompleted] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [transfer] = useMutation(TRANSFER_ORGANIZATION_CREATORSHIP);
  const [loadMembers, members] = useLazyQuery<{
    organizationMembers: Member[];
  }>(ORGANIZATION_MEMBERS);

  if (currentUserId !== organization.creatorUserId) return null;

  const recipients = (members.data?.organizationMembers ?? []).filter(
    (owner) =>
      owner.role === "OWNER" && owner.userId !== organization.creatorUserId,
  );
  const recipientItems = recipients.map((owner) => ({
    value: owner.userId,
    label: owner.email,
  }));
  const fetchMembers = () =>
    loadMembers({ variables: { organizationId: organization.id } });

  const setDialogOpen = (next: boolean) => {
    if (submitting || refreshing) return;
    setOpen(next);
    if (next && !members.called) {
      void fetchMembers().catch(() => {});
    }
    if (!next) {
      setRecipientId(null);
      setErrorMessage(null);
    }
  };

  const submit = async () => {
    if (!recipientId || submitting || transferCompleted) return;
    setErrorMessage(null);
    setSubmitting(true);
    try {
      await transfer({
        variables: {
          organizationId: organization.id,
          newCreatorUserId: recipientId,
        },
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Something went wrong.",
      );
      setSubmitting(false);
      return;
    }

    setTransferCompleted(true);
    try {
      await onTransferred();
      setOpen(false);
      setRecipientId(null);
    } catch {
      setRefreshError(
        "The transfer completed, but organizations could not be refreshed.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const retryRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await onTransferred();
      setOpen(false);
      setRecipientId(null);
    } catch {
      setRefreshError(
        "The transfer completed, but organizations could not be refreshed.",
      );
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        aria-label={`Transfer creatorship for ${organization.name}`}
        onClick={() => setDialogOpen(true)}
      >
        <ArrowRightLeft className="mr-2 h-4 w-4" />
        Transfer
      </Button>
      <Dialog open={open} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer creatorship</DialogTitle>
            <DialogDescription>
              Choose another owner to inherit the account plan for{" "}
              {organization.name}. After the transfer, you will remain an owner.
            </DialogDescription>
          </DialogHeader>
          {transferCompleted ? (
            <div className="space-y-4">
              <p className="text-sm font-medium">
                Creatorship was transferred successfully.
              </p>
              {submitting && (
                <p className="text-sm text-muted-foreground">
                  Refreshing organizations…
                </p>
              )}
              {refreshError && (
                <p role="alert" className="text-sm text-destructive">
                  {refreshError} The transfer will not be repeated.
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  disabled={submitting || refreshing}
                  onClick={() => setDialogOpen(false)}
                >
                  Close
                </Button>
                {refreshError && (
                  <Button
                    disabled={refreshing}
                    onClick={() => void retryRefresh()}
                  >
                    {refreshing ? "Refreshing…" : "Retry refresh"}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {members.loading && (
                <p className="text-sm text-muted-foreground">Loading owners…</p>
              )}
              {members.error && (
                <div className="space-y-2">
                  <p role="alert" className="text-sm text-destructive">
                    {members.error.message}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void fetchMembers().catch(() => {})}
                  >
                    Retry loading owners
                  </Button>
                </div>
              )}
              {!members.loading && !members.error && members.called && (
                <div className="space-y-2">
                  <Label htmlFor={`new-creator-${organization.id}`}>
                    New creator
                  </Label>
                  <Select
                    items={recipientItems}
                    value={recipientId}
                    onValueChange={setRecipientId}
                    disabled={submitting || recipients.length === 0}
                  >
                    <SelectTrigger
                      id={`new-creator-${organization.id}`}
                      aria-label="New creator"
                      className="w-full min-w-0"
                    >
                      <SelectValue placeholder="Select an owner" />
                    </SelectTrigger>
                    <SelectContent>
                      {recipients.map((owner) => (
                        <SelectItem key={owner.userId} value={owner.userId}>
                          {owner.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {recipients.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      Add another owner before transferring creatorship.
                    </p>
                  )}
                </div>
              )}
              {errorMessage && (
                <p role="alert" className="text-sm text-destructive">
                  {errorMessage}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  disabled={submitting}
                  onClick={() => setDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  aria-label="Confirm transfer"
                  disabled={!recipientId || submitting}
                  onClick={() => void submit()}
                >
                  {submitting ? "Transferring…" : "Confirm transfer"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
