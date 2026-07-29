import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertWorkspaceSelector,
  type ResolvedWorkspace,
  type WorkspaceSelector,
} from './workspace-selector';

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveForUser(
    userId: string,
    selector: WorkspaceSelector,
  ): Promise<ResolvedWorkspace> {
    const asserted = assertWorkspaceSelector(selector);

    if ('organizationId' in asserted) {
      const organization = await this.prisma.organization.findFirst({
        where: {
          id: asserted.organizationId,
          memberships: { some: { userId } },
        },
        select: {
          id: true,
          projects: {
            select: { id: true },
            take: 2,
          },
        },
      });
      if (!organization) {
        throw new ForbiddenException('Workspace not found');
      }
      if (organization.projects.length !== 1) {
        throw new InternalServerErrorException(
          'Organization workspace is inconsistent',
        );
      }
      return {
        organizationId: organization.id,
        projectId: organization.projects[0].id,
      };
    }

    const project = await this.prisma.project.findFirst({
      where: {
        id: asserted.projectId,
        organization: { memberships: { some: { userId } } },
      },
      select: { id: true, organizationId: true },
    });
    if (!project) {
      throw new ForbiddenException('Workspace not found');
    }
    return {
      organizationId: project.organizationId,
      projectId: project.id,
    };
  }

  async resolveOrganizationForProject(projectId: string): Promise<string> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true },
    });
    if (!project) {
      throw new ForbiddenException('Workspace not found');
    }
    return project.organizationId;
  }
}
