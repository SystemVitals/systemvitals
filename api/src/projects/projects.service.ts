import { ForbiddenException, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
  ) {}

  private rotatePingKey(projectId: string) {
    const newPingKey = randomBytes(20).toString('hex');
    return this.prisma.project.update({
      where: { id: projectId },
      data: { pingKey: newPingKey },
    });
  }

  async regeneratePingKey(userId: string, projectId: string) {
    const workspace = await this.workspaces.resolveForUser(userId, {
      projectId,
    });
    return this.rotatePingKey(workspace.projectId);
  }

  async regenerateOrganizationPingKey(userId: string, organizationId: string) {
    const workspace = await this.workspaces.resolveForUser(userId, {
      organizationId,
    });
    const organization = await this.prisma.organization.findFirst({
      where: {
        id: workspace.organizationId,
        memberships: { some: { userId } },
      },
      include: {
        projects: true,
        memberships: {
          where: { userId },
          select: { role: true },
          take: 1,
        },
        creator: { include: { subscription: true } },
      },
    });
    if (!organization || organization.memberships.length !== 1) {
      throw new ForbiddenException('Workspace not found');
    }
    const project = await this.rotatePingKey(workspace.projectId);
    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      pingKey: project.pingKey,
      role: organization.memberships[0].role,
      plan: organization.creator.subscription?.plan ?? 'SOLO',
      creatorUserId: organization.creatorUserId,
      creatorLabel: organization.creator.email,
      projects: organization.projects.map((candidate) =>
        candidate.id === project.id ? project : candidate,
      ),
    };
  }

  listForUser(userId: string) {
    return this.prisma.project.findMany({
      where: { organization: { memberships: { some: { userId } } } },
      orderBy: { createdAt: 'asc' },
    });
  }
}
