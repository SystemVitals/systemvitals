import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@systemvitals/database';
import { lockProjectCheckStatusChanges } from '../common/project-check-status-lock';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StatusPagesService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertProjectAccess(
    db: Prisma.TransactionClient | PrismaService,
    userId: string,
    projectId: string,
  ) {
    const project = await db.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new ForbiddenException('Project not found');

    const m = await db.membership.findUnique({
      where: {
        userId_organizationId: {
          userId,
          organizationId: project.organizationId,
        },
      },
    });
    if (!m) throw new ForbiddenException('Not a member of this organization');
    return project;
  }

  private async assertStatusPageAccess(
    db: Prisma.TransactionClient | PrismaService,
    userId: string,
    statusPageId: string,
  ) {
    const page = await db.statusPage.findUnique({
      where: { id: statusPageId },
      include: { project: true },
    });
    if (!page) throw new NotFoundException('StatusPage not found');

    const m = await db.membership.findUnique({
      where: {
        userId_organizationId: {
          userId,
          organizationId: page.project.organizationId,
        },
      },
    });
    if (!m) throw new ForbiddenException('Not a member of this organization');
    return page;
  }

  private async assertChecksInProject(
    db: Prisma.TransactionClient | PrismaService,
    projectId: string,
    checkIds: string[],
  ): Promise<void> {
    if (checkIds.length === 0) return;

    const checks = await db.check.findMany({
      where: { id: { in: checkIds }, projectId },
      select: { id: true },
    });

    if (checks.length !== checkIds.length) {
      throw new BadRequestException(
        'One or more checkIds do not belong to this project',
      );
    }
  }

  private parseBranding(brandingJson?: string | null): object | null {
    if (!brandingJson) return null;
    try {
      const parsed: unknown = JSON.parse(brandingJson);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new BadRequestException('brandingJson must be a JSON object');
      }
      return parsed;
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException('brandingJson must be valid JSON');
    }
  }

  private mapPage(page: {
    id: string;
    slug: string;
    title: string;
    branding: unknown;
    checkIds: string[];
    projectId: string;
  }) {
    return {
      id: page.id,
      slug: page.slug,
      title: page.title,
      branding: page.branding != null ? JSON.stringify(page.branding) : null,
      checkIds: page.checkIds,
      projectId: page.projectId,
    };
  }

  async create(
    userId: string,
    projectId: string,
    slug: string,
    title: string,
    checkIds: string[],
    brandingJson?: string,
  ) {
    const branding = this.parseBranding(brandingJson);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockProjectCheckStatusChanges(tx, [projectId]);
        await this.assertProjectAccess(tx, userId, projectId);
        await this.assertChecksInProject(tx, projectId, checkIds);

        const page = await tx.statusPage.create({
          data: {
            projectId,
            slug,
            title,
            checkIds,
            ...(branding != null ? { branding } : {}),
          },
        });
        return this.mapPage(page);
      });
    } catch (e: unknown) {
      if (
        typeof e === 'object' &&
        e !== null &&
        'code' in e &&
        (e as { code: string }).code === 'P2002'
      ) {
        throw new ConflictException(
          `A status page with slug "${slug}" already exists`,
        );
      }
      throw e;
    }
  }

  async list(userId: string, projectId: string) {
    await this.assertProjectAccess(this.prisma, userId, projectId);
    const pages = await this.prisma.statusPage.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
    return pages.map((p) => this.mapPage(p));
  }

  async update(
    userId: string,
    id: string,
    data: { title?: string; checkIds?: string[]; brandingJson?: string },
  ) {
    const branding =
      data.brandingJson !== undefined
        ? this.parseBranding(data.brandingJson)
        : undefined;

    return this.prisma.$transaction(async (tx) => {
      const initialPage = await tx.statusPage.findUnique({
        where: { id },
        select: { projectId: true },
      });
      if (!initialPage) throw new NotFoundException('StatusPage not found');

      await lockProjectCheckStatusChanges(tx, [initialPage.projectId]);
      const page = await this.assertStatusPageAccess(tx, userId, id);
      if (page.projectId !== initialPage.projectId) {
        throw new ConflictException(
          'Status page project changed during the operation',
        );
      }
      if (data.checkIds !== undefined) {
        await this.assertChecksInProject(tx, page.projectId, data.checkIds);
      }

      const updated = await tx.statusPage.update({
        where: { id },
        data: {
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.checkIds !== undefined ? { checkIds: data.checkIds } : {}),
          ...(branding !== undefined
            ? { branding: branding ?? undefined }
            : {}),
        },
      });
      return this.mapPage(updated);
    });
  }

  async delete(userId: string, id: string): Promise<boolean> {
    await this.assertStatusPageAccess(this.prisma, userId, id);
    await this.prisma.statusPage.delete({ where: { id } });
    return true;
  }
}
