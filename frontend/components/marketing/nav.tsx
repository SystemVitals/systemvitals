"use client";
import Link from "next/link";
import { useState } from "react";
import { Menu } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { Wordmark } from "@/components/brand/wordmark";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { SITE } from "@/lib/site";

export function MarketingNav() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Wordmark />
        <div className="hidden items-center gap-6 md:flex">
          {SITE.nav.map((l) => (
            <Link key={l.href} href={l.href} className="text-sm text-muted-foreground hover:text-foreground">{l.label}</Link>
          ))}
        </div>
        <div className="hidden items-center gap-3 md:flex">
          {user ? (
            <Link href="/dashboard" className={buttonVariants()}>Dashboard</Link>
          ) : (
            <>
              <Link href="/login" className="text-sm font-medium">Login</Link>
              <Link href="/signup" className={buttonVariants()}>Start free</Link>
            </>
          )}
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger
            render={
              <Button variant="ghost" size="icon" aria-label="Menu" className="md:hidden">
                <Menu className="h-5 w-5" />
              </Button>
            }
          />
          <DialogContent className="flex flex-col gap-4">
            <DialogTitle className="sr-only">Menu</DialogTitle>
            {SITE.nav.map((l) => (
              <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="text-base">{l.label}</Link>
            ))}
            {user ? (
              <Link href="/dashboard" className={buttonVariants()}>Dashboard</Link>
            ) : (
              <>
                <Link href="/login">Login</Link>
                <Link href="/signup" className={buttonVariants()}>Start free</Link>
              </>
            )}
          </DialogContent>
        </Dialog>
      </nav>
    </header>
  );
}
