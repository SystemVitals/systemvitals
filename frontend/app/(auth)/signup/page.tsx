"use client";
import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Wordmark } from "@/components/brand/wordmark";
import { Heartbeat } from "@/components/heartbeat";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { cn } from "@/lib/utils";
import { safeNext } from "@/lib/safe-next";

// Isolated so only this leaf needs a Suspense boundary — useSearchParams()
// bails out of static rendering otherwise, and the rest of the page (the
// form) has no reason to wait on it. Mirrors the `SearchParamsHandler` leaf
// on `/login` (see `app/(auth)/login/page.tsx`): capturing `next` is a plain
// ref mutation, not a state update, so it needs no idempotency guard —
// re-deriving the same validated string on every re-run is a harmless no-op.
function NextParamReader({
  nextPathRef,
}: {
  nextPathRef: MutableRefObject<string>;
}) {
  const searchParams = useSearchParams();

  useEffect(() => {
    nextPathRef.current = safeNext(searchParams.get("next"));
  }, [searchParams, nextPathRef]);

  return null;
}

export default function SignupPage() {
  const { signup } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const nextPathRef = useRef("/dashboard");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await signup(email, password);
      router.push(nextPathRef.current);
    } catch {
      setErrorMessage(
        "Sign up failed. The email may already be in use or your password is too weak."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
      <Suspense fallback={null}>
        <NextParamReader nextPathRef={nextPathRef} />
      </Suspense>

      <Card className="w-full max-w-sm border-border bg-card shadow-sm">
        <CardHeader className="items-center gap-4 pb-2">
          <Wordmark className="text-foreground" />
          <Heartbeat
            variant="divider"
            className="text-primary/40 w-full"
          />
          <div className="text-center space-y-1 pt-1">
            <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">
              Create account
            </h1>
            <p className="text-sm text-muted-foreground">
              Start monitoring your systems in minutes
            </p>
          </div>
        </CardHeader>

        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-foreground">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="bg-background border-border"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-foreground">
                Password
              </Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                className="bg-background border-border"
              />
              <p className="text-xs text-muted-foreground">Minimum 8 characters.</p>
            </div>
          </CardContent>

          <CardFooter className="flex flex-col gap-3 border-t-0 bg-transparent pt-(--card-spacing) pb-(--card-spacing)">
            <Button
              type="submit"
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={loading}
            >
              {loading ? "Creating account…" : "Create account"}
            </Button>

            <GoogleSignInButton />

            <p className="text-center text-xs leading-5 text-muted-foreground">
              By creating an account, you agree to the{" "}
              <Link href="/terms" className="font-medium text-foreground hover:underline">
                Terms
              </Link>{" "}
              and acknowledge the{" "}
              <Link href="/privacy" className="font-medium text-foreground hover:underline">
                Privacy Policy
              </Link>
              .
            </p>

            <p className="text-sm text-muted-foreground text-center">
              Already have an account?{" "}
              <Link
                href="/login"
                className={cn(
                  buttonVariants({ variant: "link", size: "default" }),
                  "h-auto p-0 text-sm font-medium"
                )}
              >
                Sign in
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>

      <Dialog open={!!errorMessage} onOpenChange={() => setErrorMessage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign up failed</DialogTitle>
            <DialogDescription>{errorMessage}</DialogDescription>
          </DialogHeader>
          <Button onClick={() => setErrorMessage(null)}>Dismiss</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
