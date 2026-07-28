import { ForbiddenException, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { slugify } from '../common/slug';
import { createWithUniqueSlug } from '../common/create-with-unique-slug';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertMember(userId: string, organizationId: string) {
    const m = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
    });
    if (!m) throw new ForbiddenException('Not a member of this organization');
  }

  private async assertProjectAccess(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new ForbiddenException('Project not found');
    await this.assertMember(userId, project.organizationId);
    return project;
  }

  async create(userId: string, organizationId: string, name: string) {
    await this.assertMember(userId, organizationId);
    return createWithUniqueSlug({
      base: slugify(name),
      loadTakenSlugs: async () => {
        const existing = await this.prisma.project.findMany({
          where: { organizationId },
          select: { slug: true },
        });
        return existing.map((p) => p.slug);
      },
      entityLabel: 'project',
      create: (slug) =>
        this.prisma.project.create({ data: { name, slug, organizationId } }),
    });
  }

  async regeneratePingKey(userId: string, projectId: string) {
    await this.assertProjectAccess(userId, projectId);
    const newPingKey = randomBytes(20).toString('hex');
    return this.prisma.project.update({
      where: { id: projectId },
      data: { pingKey: newPingKey },
    });
  }

  listForUser(userId: string) {
    return this.prisma.project.findMany({
      where: { organization: { memberships: { some: { userId } } } },
      orderBy: { createdAt: 'asc' },
    });
  }
}
