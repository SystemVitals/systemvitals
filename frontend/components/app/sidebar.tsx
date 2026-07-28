"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AlertTriangle,
  Bell,
  Building2,
  CreditCard,
  Globe,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Shield,
  UserCog,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Wordmark } from "@/components/brand/wordmark";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { OrgSwitcher } from "@/components/app/org-switcher";

export const APP_NAV = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Channels", href: "/channels", icon: Bell },
  { label: "Escalation", href: "/escalation", icon: AlertTriangle },
  { label: "Status pages", href: "/status-pages", icon: Globe },
  { label: "Team", href: "/team", icon: Users },
  { label: "Organizations", href: "/organizations", icon: Building2 },
  { label: "Billing", href: "/billing", icon: CreditCard },
  { label: "Account", href: "/account", icon: UserCog },
  {
    label: "Agent connections",
    href: "/account/agent-connections",
    icon: KeyRound,
  },
];

export function AppSidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();

  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r bg-sidebar text-sidebar-foreground">
      {/* Logo */}
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <Wordmark href="/dashboard" />
      </div>

      {/* Organization switcher (hidden unless the user is in several orgs) */}
      <div className="pt-2">
        <OrgSwitcher />
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-4">
        <ul className="space-y-1">
          {APP_NAV.map(({ label, href, icon: Icon }) => {
            const active =
              pathname === href ||
              (href !== "/account" && pathname.startsWith(href + "/"));
            return (
              <li key={href}>
                <Link
                  href={href}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-primary/10 hover:text-primary",
                    active && "bg-primary/10 text-primary"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Admin link (only visible to admins) */}
      {user?.isAdmin && (
        <div className="px-2 pb-2">
          <Link
            href="/admin"
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-primary/10 hover:text-primary",
              pathname === "/admin" || pathname.startsWith("/admin/")
                ? "bg-primary/10 text-primary"
                : "text-sidebar-foreground/70"
            )}
          >
            <Shield className="h-4 w-4 shrink-0" />
            Admin
          </Link>
        </div>
      )}

      {/* Bottom: user info + sign out */}
      <div className="border-t border-sidebar-border p-4">
        <p className="mb-2 truncate text-xs text-sidebar-foreground/70">{user?.email}</p>
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
