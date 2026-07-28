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
// form) has no reason to wait on it. Handles two concerns that both need the
// same searchParams read: surfacing the Google OAuth error dialog, and
// capturing a validated `next` redirect target for use after a successful
// login.
//
// Takes the `setErrorMessage` state setter directly (rather than an
// `onError` callback built by the parent) because React guarantees setter
// identity is stable across renders. An inline callback recreated on every
// `LoginPage` render would give this effect a new dependency each time.
// `nextPathRef` is a plain ref for the same reason — its identity never
// changes, and mutating `.current` doesn't need the deferral a state update
// would.
//
// `useSearchParams()` returns a new object identity on every render, so this
// effect would re-run every time regardless of the setter's stability. A
// `handled` ref (same pattern as the OAuth callback page, see
// `app/auth/callback/page.tsx`) makes surfacing the error idempotent — it
// fires only once per mount, regardless of render timing or Strict Mode's
// double-invoke. The `router.replace` clears the param to prevent a page
// refresh from re-triggering it. Capturing `next` has no such idempotency
// requirement — re-deriving the same validated string on every re-run is a
// harmless no-op.
function SearchParamsHandler({
  setErrorMessage,
  nextPathRef,
}: {
  setErrorMessage: (message: string) => void;
  nextPathRef: MutableRefObject<string>;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const handled = useRef(false);

  useEffect(() => {
    nextPathRef.current = safeNext(searchParams.get("next"));

    if (handled.current) return;
    if (searchParams.get("error") !== "google") return;

    // Set synchronously, in the effect body — not inside the deferred
    // microtask below — so a second effect run can never pass this guard
    // before the first run's microtask has had a chance to fire.
    handled.current = true;

    Promise.resolve().then(() => {
      setErrorMessage(
        "We couldn't sign you in with Google. Please try again or use your email and password."
      );
    });
    // Strip the param so it can't re-trigger this on the next render or
    // page refresh. `replace` (not `push`) keeps the dirty URL out of
    // history.
    router.replace("/login");
  }, [searchParams, setErrorMessage, router, nextPathRef]);

  return null;
}

export default function LoginPage() {
  const { login } = useAuth();
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
      await login(email, password);
      router.replace(nextPathRef.current);
    } catch {
      setErrorMessage(
        "Login failed. Please check your credentials and try again."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
      <Suspense fallback={null}>
        <SearchParamsHandler
          setErrorMessage={setErrorMessage}
          nextPathRef={nextPathRef}
        />
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
              Sign in
            </h1>
            <p className="text-sm text-muted-foreground">
              Enter your credentials to access your dashboard
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
                autoComplete="current-password"
                className="bg-background border-border"
              />
            </div>
          </CardContent>

          <CardFooter className="flex flex-col gap-3 border-t-0 bg-transparent pt-(--card-spacing) pb-(--card-spacing)">
            <Button
              type="submit"
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={loading}
            >
              {loading ? "Signing in…" : "Sign in"}
            </Button>

            <GoogleSignInButton />

            <p className="text-sm text-muted-foreground text-center">
              Don&apos;t have an account?{" "}
              <Link
                href="/signup"
                className={cn(
                  buttonVariants({ variant: "link", size: "default" }),
                  "h-auto p-0 text-sm font-medium"
                )}
              >
                Sign up
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>

      <Dialog open={!!errorMessage} onOpenChange={() => setErrorMessage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign in failed</DialogTitle>
            <DialogDescription>{errorMessage}</DialogDescription>
          </DialogHeader>
          <Button onClick={() => setErrorMessage(null)}>Dismiss</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
