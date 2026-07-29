import type { PrismaClient } from "@prisma/client";

export interface OrganizationWorkspaceCount {
  organizationId: string;
  projectCount: number;
}

export function incompatibleOrganizationWorkspaces(
  rows: readonly OrganizationWorkspaceCount[],
): OrganizationWorkspaceCount[] {
  return rows
    .filter(({ projectCount }) => projectCount !== 1)
    .sort((left, right) =>
      left.organizationId.localeCompare(right.organizationId),
    );
}

export async function inspectOrganizationWorkspaces(
  prisma: PrismaClient,
): Promise<OrganizationWorkspaceCount[]> {
  return prisma.$queryRaw<OrganizationWorkspaceCount[]>`
    SELECT o.id AS "organizationId", COUNT(p.id)::int AS "projectCount"
    FROM organizations o
    LEFT JOIN projects p ON p.organization_id=o.id
    GROUP BY o.id
    HAVING COUNT(p.id)<>1
    ORDER BY o.id
  `;
}
