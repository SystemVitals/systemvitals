"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Menu, LogOut, Shield } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { OrgProvider } from "@/lib/org-context";
import {
  AppNavSections,
  AppSidebar,
  isNavActive,
  navLinkClass,
} from "@/components/app/sidebar";
import { OrgSwitcher } from "@/components/app/org-switcher";
import { ImpersonationBanner } from "@/components/app/impersonation-banner";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const isAdmin = user?.isAdmin ?? false;

  function handleLogout() {
    onClose();
    logout();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 overflow-y-auto">
        <DialogTitle className="sr-only">Navigation menu</DialogTitle>
        <div className="-mx-2 border-b pb-3">
          <OrgSwitcher />
        </div>
        <nav aria-label="Main">
          <AppNavSections onNavigate={onClose} />
        </nav>
        {isAdmin && (
          <div className="border-t pt-3">
            <Link
              href="/admin"
              onClick={onClose}
              className={navLinkClass(isNavActive(pathname, "/admin"))}
            >
              <Shield className="h-4 w-4 shrink-0" />
              Admin
            </Link>
          </div>
        )}
        <div className="border-t pt-4 flex flex-col gap-2">
          {user?.email && (
            <p className="truncate text-xs text-muted-foreground px-3">{user.email}</p>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
            onClick={handleLogout}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const redirectingRef = useRef(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (loading || user || redirectingRef.current) return;

    redirectingRef.current = true;
    const nextPath = `${window.location.pathname}${window.location.search}`;
    router.replace(`/login?next=${encodeURIComponent(nextPath)}`);
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p role="status" className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <OrgProvider>
    <ImpersonationBanner />
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex">
        <AppSidebar />
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col lg:ml-56">
        {/* Mobile top bar */}
        <header className="flex h-14 items-center justify-between border-b px-4 lg:hidden">
          <Wordmark href="/dashboard" />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Menu"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </Button>
        </header>

        <main className="mx-auto w-full max-w-6xl p-4 sm:p-8">
          {children}
        </main>
      </div>

      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
    </OrgProvider>
  );
}
