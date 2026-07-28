// Shared admin interfaces and helpers — imported by all admin pages.

export interface AdminUserOrg {
  id: string;
  name: string;
  role: string;
}

export interface AdminUser {
  id: string;
  email: string;
  isAdmin: boolean;
  suspendedAt: string | null;
  createdAt: string;
  organizations: AdminUserOrg[];
}

export interface AdminOrgMember {
  userId: string;
  email: string;
  role: string;
}

export interface AdminOrganization {
  id: string;
  name: string;
  createdAt: string;
  projectCount: number;
  plan: string;
  members: AdminOrgMember[];
}

export interface AdminSubscription {
  id: string;
  userId: string;
  userEmail: string;
  plan: string;
  status: string;
  manualOverride: boolean;
  limitsJson: string | null;
  stripeSubscriptionId: string | null;
  createdAt: string;
}

/** Returns Tailwind token classes for plan tier badges. */
export function planBadgeClass(plan: string): string {
  switch (plan.toUpperCase()) {
    case "SIGNAL":
      return "bg-primary/15 text-primary";
    case "FLEET":
      return "bg-success/15 text-success";
    default:
      return "bg-muted text-muted-foreground";
  }
}
