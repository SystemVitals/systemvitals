import { GoogleMark } from "@/components/brand/google-mark";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_API_URL;
const GOOGLE_ENABLED = process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED === "true";

/**
 * Renders nothing unless the API has Google auth configured. This is a real
 * navigation, not a fetch — the OAuth flow is a redirect.
 */
export function GoogleSignInButton() {
  if (!GOOGLE_ENABLED) return null;
  return (
    <>
      <div className="flex w-full items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">or</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <a
        href={`${API_URL}/auth/google`}
        className={cn(buttonVariants({ variant: "outline" }), "w-full gap-2")}
      >
        <GoogleMark className="h-4 w-4" />
        Continue with Google
      </a>
    </>
  );
}
