"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "@apollo/client/react";
import { useAuth } from "@/lib/auth-context";
import { INVITE_PREVIEW, ACCEPT_INVITE } from "@/lib/queries";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

interface Preview {
  organizationName: string;
  maskedEmail: string;
  status: string;
}

/** Human-readable copy for every non-acceptable invite state. */
const DEAD_STATES: Record<string, string> = {
  EXPIRED: "This invite has expired. Ask whoever invited you to send a new one.",
  REVOKED: "This invite was revoked and is no longer valid.",
  ACCEPTED: "This invite has already been accepted.",
  NOT_FOUND: "We could not find this invite. Check the link and try again.",
};

export default function InvitePage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const router = useRouter();
  const { user, loading: authLoading, refetchMe } = useAuth();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data, loading } = useQuery<{ invitePreview: Preview }>(
    INVITE_PREVIEW,
    { variables: { token } },
  );

  const [acceptInvite, acceptState] = useMutation(ACCEPT_INVITE, {
    variables: { token },
    onCompleted: async () => {
      // The invite is already accepted server-side at this point. Refreshing
      // `me` first means /team renders scoped to the org just joined rather
      // than stale data -- but if that refresh fails (a network blip), the
      // accept still stands, so navigate anyway rather than stranding the
      // user on a dead invite page. /team self-heals on its own next fetch.
      try {
        await refetchMe();
      } catch {
        // non-fatal: the accept succeeded regardless
      }
      router.push("/team");
    },
    onError: (e) => setErrorMessage(e.message),
  });

  const preview = data?.invitePreview;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md items-center p-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>
            {loading
              ? "Loading invite…"
              : preview?.status === "PENDING"
                ? `Join ${preview.organizationName}`
                : "Invite unavailable"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!loading && preview && preview.status !== "PENDING" && (
            <p className="text-sm text-muted-foreground">
              {DEAD_STATES[preview.status] ?? DEAD_STATES.NOT_FOUND}
            </p>
          )}

          {!loading && preview?.status === "PENDING" && (
            <>
              <p className="text-sm text-muted-foreground">
                You have been invited to join{" "}
                <strong>{preview.organizationName}</strong> on SystemVitals as{" "}
                {preview.maskedEmail}.
              </p>

              {authLoading && (
                <p className="text-sm text-muted-foreground">
                  Checking your session…
                </p>
              )}

              {!authLoading && !user && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Log in or create an account with that email address to
                    accept.
                  </p>
                  <div className="flex gap-2">
                    <Link
                      href={`/login?next=/invite/${token}`}
                      className={buttonVariants({
                        variant: "default",
                        className: "flex-1",
                      })}
                    >
                      Log in
                    </Link>
                    <Link
                      href={`/signup?next=/invite/${token}`}
                      className={buttonVariants({
                        variant: "outline",
                        className: "flex-1",
                      })}
                    >
                      Sign up
                    </Link>
                  </div>
                </div>
              )}

              {!authLoading && user && (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Signed in as {user.email}. If that is not the invited
                    address, log out and sign in with the right account.
                  </p>
                  <Button
                    className="w-full"
                    disabled={acceptState.loading}
                    onClick={() => void acceptInvite()}
                  >
                    {acceptState.loading ? "Accepting…" : "Accept invite"}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!errorMessage} onOpenChange={() => setErrorMessage(null)}>
        <DialogContent>
          <DialogTitle>Could not accept the invite</DialogTitle>
          <DialogDescription>{errorMessage}</DialogDescription>
          <Button onClick={() => setErrorMessage(null)}>Dismiss</Button>
        </DialogContent>
      </Dialog>
    </main>
  );
}
