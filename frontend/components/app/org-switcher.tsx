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

/**
 * The org select appears only when the user belongs to more than one org, but
 * the "Create team" action is always available so a single-org user can make
 * another. The create flow lives in the shared CreateTeamDialog.
 */
export function OrgSwitcher() {
  const { orgs, activeOrgId, setActiveOrgId } = useOrg();

  return (
    <div className="px-2 pb-2 space-y-1">
      {orgs.length >= 2 && (
        <Select
          items={orgs.map((org) => ({ value: org.id, label: org.name }))}
          value={activeOrgId ?? undefined}
          onValueChange={(id) => id && setActiveOrgId(id)}
        >
          <SelectTrigger aria-label="Organization" className="w-full">
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
      )}

      <CreateTeamDialog variant="ghost" className="w-full justify-start" />
    </div>
  );
}
