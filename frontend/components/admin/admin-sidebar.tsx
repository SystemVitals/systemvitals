"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, Building2, CheckSquare, CreditCard, FileText, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { Wordmark } from "@/components/brand/wordmark";

export const ADMIN_NAV = [
  { label: "Overview", href: "/admin", icon: LayoutDashboard },
  { label: "Users", href: "/admin/users", icon: Users },
  { label: "Organizations", href: "/admin/organizations", icon: Building2 },
  { label: "Projects & Checks", href: "/admin/checks", icon: CheckSquare },
  { label: "Subscriptions", href: "/admin/subscriptions", icon: CreditCard },
  { label: "Audit log", href: "/admin/audit", icon: FileText },
];

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r bg-sidebar text-sidebar-foreground">
      {/* Logo + Admin badge */}
      <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
        <Wordmark href="/admin" />
        <span className="ml-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
          Admin
        </span>
      </div>

      {/* Nav */}
      <nav aria-label="Admin navigation" className="flex-1 overflow-y-auto px-2 py-4">
        <ul className="space-y-1">
          {ADMIN_NAV.map(({ label, href, icon: Icon }) => {
            const active =
              href === "/admin"
                ? pathname === "/admin"
                : pathname === href || pathname.startsWith(href + "/");
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

      {/* Back to app */}
      <div className="border-t border-sidebar-border p-4">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 text-sm text-sidebar-foreground/70 transition-colors hover:text-sidebar-foreground"
        >
          <ArrowLeft className="h-4 w-4 shrink-0" />
          Back to app
        </Link>
      </div>
    </aside>
  );
}
