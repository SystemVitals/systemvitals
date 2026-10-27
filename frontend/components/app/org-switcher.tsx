"use client";

import { useOrg } from "@/lib/org-context";
import { CreateTeamDialog } from "@/components/app/create-team-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function OrgInitial({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-semibold text-primary"
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/**
 * Always shows which organization the monitoring pages are scoped to. The
 * select appears only when the user belongs to more than one org; the
 * "New organization" action is always available so a single-org user can make
 * another. The create flow lives in the shared CreateTeamDialog.
 */
export function OrgSwitcher() {
  const { orgs, activeOrg, activeOrgId, setActiveOrgId } = useOrg();

  return (
    <div className="space-y-1.5 px-2">
      <p className="px-1 text-[11px] font-medium uppercase tracking-wider text-sidebar-foreground/50">
        Workspace
      </p>
      {orgs.length >= 2 ? (
        <Select
          items={orgs.map((org) => ({ value: org.id, label: org.name }))}
          value={activeOrgId ?? undefined}
          onValueChange={(id) => id && setActiveOrgId(id)}
        >
          <SelectTrigger aria-label="Organization" className="w-full bg-background">
            <SelectValue placeholder="Select organization" />
          </SelectTrigger>
          <SelectContent>
            {orgs.map((org) => (
              <SelectItem key={org.id} value={org.id}>
                {org.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : activeOrg ? (
        <div
          className="flex min-w-0 items-center gap-2 rounded-md border bg-background px-2 py-1.5"
          title={activeOrg.name}
        >
          <OrgInitial name={activeOrg.name} />
          <span className="truncate text-sm font-medium">{activeOrg.name}</span>
        </div>
      ) : null}

      <CreateTeamDialog
        variant="ghost"
        className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground"
      />
    </div>
  );
}
