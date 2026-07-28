"use client";

import { useMutation, useQuery } from "@apollo/client/react";
import {
  AlertTriangle,
  Check,
  Clock3,
  LoaderCircle,
  MailCheck,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";

import { Wordmark } from "@/components/brand/wordmark";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import {
  EMAIL_CHANNEL_VERIFICATION_PREVIEW,
  VERIFY_EMAIL_CHANNEL,
} from "@/lib/queries";
import { cn } from "@/lib/utils";

type PreviewStatus = "PENDING" | "EXPIRED" | "INVALID";

type Preview = {
  status: PreviewStatus;
  maskedEmail: string | null;
  projectName: string | null;
  expiresAt: string | null;
};

type Confirmation = {
  status: "VERIFIED" | "EXPIRED" | "INVALID";
  maskedEmail: string | null;
  projectName: string | null;
};

const invalidState: Preview = {
  status: "INVALID",
  maskedEmail: null,
  projectName: null,
  expiresAt: null,
};

function VerificationShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-muted/30 px-4 py-12">
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-primary/50 to-transparent"
      />
      <div className="relative w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Wordmark className="text-foreground" />
        </div>
        {children}
        <p className="mt-5 text-center text-xs leading-relaxed text-muted-foreground">
          Secure email confirmation · SystemVitals
        </p>
      </div>
    </main>
  );
}

function LoadingCard() {
  return (
    <VerificationShell>
      <Card
        className="border-border bg-card shadow-sm"
        role="status"
        aria-label="Checking verification link"
      >
        <CardHeader className="items-center gap-5 py-8 text-center">
          <LoaderCircle
            className="size-8 animate-spin text-primary"
            aria-hidden="true"
          />
          <div className="space-y-2">
            <h1 className="font-heading text-xl font-semibold tracking-tight">
              Checking your verification link
            </h1>
            <p className="text-sm text-muted-foreground">
              This should only take a moment.
            </p>
          </div>
        </CardHeader>
      </Card>
    </VerificationShell>
  );
}

function StatusIcon({
  tone,
}: {
  tone: "pending" | "success" | "warning" | "invalid";
}) {
  const styles = {
    pending: "bg-primary/10 text-primary ring-primary/15",
    success: "bg-success/10 text-success ring-success/20",
    warning: "bg-warning/10 text-warning ring-warning/20",
    invalid: "bg-destructive/10 text-destructive ring-destructive/15",
  };
  const Icon =
    tone === "success"
      ? ShieldCheck
      : tone === "warning"
        ? Clock3
        : tone === "invalid"
          ? AlertTriangle
          : MailCheck;

  return (
    <div
      className={cn(
        "flex size-12 items-center justify-center rounded-full ring-1",
        styles[tone],
      )}
    >
      <Icon className="size-6" aria-hidden="true" />
    </div>
  );
}

function LoginFooter() {
  return (
    <CardFooter className="justify-center border-border bg-muted/30 py-4">
      <Link
        href="/login"
        className={buttonVariants({ variant: "link", size: "sm" })}
      >
        Log in to SystemVitals
      </Link>
    </CardFooter>
  );
}

function SafeTerminalState({ status }: { status: "EXPIRED" | "INVALID" }) {
  const expired = status === "EXPIRED";

  return (
    <VerificationShell>
      <Card className="border-border bg-card shadow-sm">
        <CardHeader className="items-center gap-5 px-6 pt-8 text-center">
          <StatusIcon tone={expired ? "warning" : "invalid"} />
          <div className="space-y-2">
            <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">
              {expired
                ? "This verification link has expired"
                : "This verification link is invalid or has already been used"}
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Ask the channel owner to send a new verification email from
              SystemVitals.
            </p>
          </div>
        </CardHeader>
        <LoginFooter />
      </Card>
    </VerificationShell>
  );
}

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [verificationError, setVerificationError] = useState(false);
  const submittingRef = useRef(false);

  const { data, loading, error, refetch } = useQuery<{
    emailChannelVerificationPreview: Preview;
  }>(EMAIL_CHANNEL_VERIFICATION_PREVIEW, {
    variables: { token: token ?? "" },
    skip: !token,
    fetchPolicy: "no-cache",
  });
  const [verifyEmail, { loading: verifying }] = useMutation<{
    verifyEmailChannel: Confirmation;
  }>(VERIFY_EMAIL_CHANNEL, { fetchPolicy: "no-cache" });

  const preview = data?.emailChannelVerificationPreview;

  async function handleVerify() {
    if (!token || submittingRef.current) return;
    submittingRef.current = true;
    setVerificationError(false);

    try {
      const result = await verifyEmail({ variables: { token } });
      const nextConfirmation = result.data?.verifyEmailChannel;
      if (!nextConfirmation) throw new Error("Missing verification result");

      setConfirmation(nextConfirmation);
      if (nextConfirmation.status === "VERIFIED") {
        try {
          window.history.replaceState(null, "", "/verify-email");
        } catch {
          // Confirmation is authoritative. URL cleanup is best-effort and
          // must never turn a committed server success into a retryable error.
        }
      }
    } catch {
      setVerificationError(true);
    } finally {
      submittingRef.current = false;
    }
  }

  if (!token) return <SafeTerminalState status="INVALID" />;
  if (loading) return <LoadingCard />;

  if (error) {
    return (
      <VerificationShell>
        <Card className="border-border bg-card shadow-sm">
          <CardHeader className="items-center gap-5 px-6 pt-8 text-center">
            <StatusIcon tone="invalid" />
            <div className="space-y-2">
              <h1 className="font-heading text-xl font-semibold tracking-tight">
                We couldn&apos;t check this link
              </h1>
              <p
                role="alert"
                className="text-sm leading-relaxed text-muted-foreground"
              >
                We couldn&apos;t check this verification link. Please try
                again.
              </p>
            </div>
          </CardHeader>
          <CardContent className="pb-4">
            <Button className="h-10 w-full" onClick={() => void refetch()}>
              Try again
            </Button>
          </CardContent>
          <LoginFooter />
        </Card>
      </VerificationShell>
    );
  }

  const current = confirmation ?? preview ?? invalidState;

  if (current.status === "EXPIRED" || current.status === "INVALID") {
    return <SafeTerminalState status={current.status} />;
  }

  if (current.status === "VERIFIED") {
    return (
      <VerificationShell>
        <Card
          className="border-border bg-card shadow-sm"
          role="status"
          aria-live="polite"
          aria-label="Email verified — alerts are now active"
        >
          <CardHeader className="items-center gap-5 px-6 pt-8 text-center">
            <StatusIcon tone="success" />
            <div className="space-y-2">
              <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">
                Email verified — alerts are now active
              </h1>
              <p className="text-sm leading-relaxed text-muted-foreground">
                SystemVitals can now send monitoring alerts for{" "}
                <span className="font-medium text-foreground">
                  {current.projectName}
                </span>{" "}
                to{" "}
                <span className="font-mono text-xs text-foreground">
                  {current.maskedEmail}
                </span>
                .
              </p>
            </div>
          </CardHeader>
          <CardContent className="pb-2">
            <div className="flex items-center justify-center gap-2 rounded-lg border border-success/20 bg-success/5 px-3 py-2.5 text-sm font-medium text-success">
              <Check className="size-4" aria-hidden="true" />
              Verification complete
            </div>
          </CardContent>
          <LoginFooter />
        </Card>
      </VerificationShell>
    );
  }

  return (
    <VerificationShell>
      <Card className="border-border bg-card shadow-sm">
        <CardHeader className="items-center gap-5 px-6 pt-8 text-center">
          <StatusIcon tone="pending" />
          <div className="space-y-2">
            <p className="font-mono text-[0.68rem] font-medium tracking-[0.18em] text-primary uppercase">
              Action required
            </p>
            <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">
              Review email verification
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Confirm this recipient before SystemVitals activates email alerts.
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pb-4">
          <dl className="divide-y divide-border rounded-lg border border-border bg-background">
            <div className="grid grid-cols-[5rem_1fr] gap-3 px-4 py-3">
              <dt className="text-xs font-medium text-muted-foreground">
                Recipient
              </dt>
              <dd className="text-right font-mono text-xs font-medium text-foreground">
                {current.maskedEmail}
              </dd>
            </div>
            <div className="grid grid-cols-[5rem_1fr] gap-3 px-4 py-3">
              <dt className="text-xs font-medium text-muted-foreground">
                Project
              </dt>
              <dd className="text-right text-sm font-medium text-foreground">
                {current.projectName}
              </dd>
            </div>
          </dl>

          {verificationError ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-center text-sm text-destructive"
            >
              We couldn&apos;t verify this email. Please try again.
            </p>
          ) : null}

          <Button
            className="h-11 w-full shadow-sm"
            disabled={verifying}
            onClick={() => void handleVerify()}
          >
            {verifying ? (
              <>
                <LoaderCircle className="animate-spin" aria-hidden="true" />
                Verifying…
              </>
            ) : (
              <>
                <ShieldCheck aria-hidden="true" />
                Verify email
              </>
            )}
          </Button>
          <p className="text-center text-xs leading-relaxed text-muted-foreground">
            Only this button activates alerts. Opening the link alone makes no
            changes.
          </p>
        </CardContent>
        <LoginFooter />
      </Card>
    </VerificationShell>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<LoadingCard />}>
      <VerifyEmailContent />
    </Suspense>
  );
}
