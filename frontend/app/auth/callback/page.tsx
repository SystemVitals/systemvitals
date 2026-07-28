"use client";
import { Suspense, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { Heartbeat } from "@/components/heartbeat";

function SigningIn() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-muted/30">
      <Heartbeat variant="divider" className="text-primary/40 w-40" />
      <p className="text-sm text-muted-foreground">Signing you in…</p>
    </div>
  );
}

function CallbackHandler() {
  const router = useRouter();
  const params = useSearchParams();
  const { loginWithToken } = useAuth();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const token = params.get("token");
    if (!token) {
      router.replace("/login?error=google");
      return;
    }
    loginWithToken(token)
      .then(() => router.replace("/dashboard"))
      .catch(() => router.replace("/login?error=google"));
  }, [params, router, loginWithToken]);

  return <SigningIn />;
}

export default function CallbackPage() {
  // useSearchParams() bails out of static rendering unless wrapped in
  // Suspense — without this, `next build` fails to prerender this route.
  return (
    <Suspense fallback={<SigningIn />}>
      <CallbackHandler />
    </Suspense>
  );
}
