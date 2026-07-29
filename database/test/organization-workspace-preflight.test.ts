import { describe, expect, it, vi } from "vitest";
import {
  incompatibleOrganizationWorkspaces,
  inspectOrganizationWorkspaces,
} from "../src/organization-workspace-preflight";

describe("organization workspace preflight", () => {
  it("returns every zero- and multi-project organization sorted by ID", () => {
    expect(
      incompatibleOrganizationWorkspaces([
        { organizationId: "org-z", projectCount: 2 },
        { organizationId: "org-valid", projectCount: 1 },
        { organizationId: "org-a", projectCount: 0 },
        { organizationId: "org-three", projectCount: 3 },
      ]),
    ).toEqual([
      { organizationId: "org-a", projectCount: 0 },
      { organizationId: "org-three", projectCount: 3 },
      { organizationId: "org-z", projectCount: 2 },
    ]);
  });

  it("uses the read-only cardinality query and returns its ordered rows", async () => {
    const rows = [
      { organizationId: "org-empty", projectCount: 0 },
      { organizationId: "org-many", projectCount: 2 },
    ];
    const queryRaw = vi.fn().mockResolvedValue(rows);
    const prisma = { $queryRaw: queryRaw };

    await expect(
      inspectOrganizationWorkspaces(prisma as never),
    ).resolves.toEqual(rows);

    expect(queryRaw).toHaveBeenCalledOnce();
    const [strings] = queryRaw.mock.calls[0] as [TemplateStringsArray];
    expect(strings.join("")).toMatch(
      /SELECT o\.id AS "organizationId", COUNT\(p\.id\)::int AS "projectCount"\s+FROM organizations o\s+LEFT JOIN projects p ON p\.organization_id=o\.id\s+GROUP BY o\.id\s+HAVING COUNT\(p\.id\)<>1\s+ORDER BY o\.id/,
    );
  });
});
