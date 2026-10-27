"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Building2,
  CreditCard,
  Globe,
  LayoutDashboard,
  LogOut,
  Shield,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Wordmark } from "@/components/brand/wordmark";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { OrgSwitcher } from "@/components/app/org-switcher";

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

// Grouped by scope so it is clear which pages follow the selected
// organization and which belong to the signed-in account.
export const APP_NAV_SECTIONS: NavSection[] = [
  {
    label: "Monitoring",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      { label: "Channels", href: "/channels", icon: Bell },
      { label: "Status pages", href: "/status-pages", icon: Globe },
    ],
  },
  {
    label: "Organization",
    items: [
      { label: "Members", href: "/team", icon: Users },
      { label: "Organizations", href: "/organizations", icon: Building2 },
    ],
  },
  {
    label: "Personal",
    items: [
      { label: "Billing", href: "/billing", icon: CreditCard },
      { label: "Account", href: "/account", icon: UserCog },
    ],
  },
];

export const APP_NAV = APP_NAV_SECTIONS.flatMap((section) => section.items);

export function isNavActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(href + "/");
}

export function navLinkClass(active: boolean) {
  return cn(
    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-primary/10 hover:text-primary",
    active && "bg-primary/10 text-primary",
  );
}

export function AppNavSections({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <div className="space-y-5">
      {APP_NAV_SECTIONS.map((section) => (
        <div key={section.label} className="space-y-1">
          <p className="px-3 text-[11px] font-medium uppercase tracking-wider text-sidebar-foreground/50">
            {section.label}
          </p>
          <ul className="space-y-0.5">
            {section.items.map(({ label, href, icon: Icon }) => {
              const active = isNavActive(pathname, href);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={navLinkClass(active)}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();

  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r bg-sidebar text-sidebar-foreground">
      {/* Logo */}
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <Wordmark href="/dashboard" />
      </div>

      {/* Current organization, switcher, and create action */}
      <div className="border-b border-sidebar-border py-3">
        <OrgSwitcher />
      </div>

      {/* Nav */}
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 py-4">
        <AppNavSections />
      </nav>

      {/* Admin link (only visible to admins) */}
      {user?.isAdmin && (
        <div className="px-2 pb-2">
          <Link
            href="/admin"
            className={navLinkClass(isNavActive(pathname, "/admin"))}
          >
            <Shield className="h-4 w-4 shrink-0" />
            Admin
          </Link>
        </div>
      )}

      {/* Bottom: user info + sign out */}
      <div className="border-t border-sidebar-border p-4">
        <p className="mb-2 truncate text-xs text-sidebar-foreground/70" title={user?.email}>
          {user?.email}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-sidebar-foreground/70 hover:text-sidebar-foreground"
          onClick={logout}
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </aside>
  );
}
