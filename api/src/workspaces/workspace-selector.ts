import { BadRequestException } from '@nestjs/common';

export interface WorkspaceSelector {
  organizationId?: string | null;
  projectId?: string | null;
}

export interface ResolvedWorkspace {
  organizationId: string;
  projectId: string;
}

export function assertWorkspaceSelector(
  selector: WorkspaceSelector,
): { organizationId: string } | { projectId: string } {
  const hasOrganizationId = selector.organizationId != null;
  const hasProjectId = selector.projectId != null;

  if (hasOrganizationId === hasProjectId) {
    throw new BadRequestException(
      'Provide exactly one of organizationId or projectId',
    );
  }

  return hasOrganizationId
    ? { organizationId: selector.organizationId! }
    : { projectId: selector.projectId! };
}
