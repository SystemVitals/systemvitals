import Link from "next/link";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";

export function Wordmark({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2 font-heading text-lg font-semibold tracking-tight", className)}>
      <Logo className="h-6 w-6 text-primary" />
      <span>SystemVitals</span>
    </Link>
  );
}
