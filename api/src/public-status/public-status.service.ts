import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface PublicCheck {
  name: string;
  status: string;
  lastEventAt: Date | null;
}

export interface PublicStatusPage {
  title: string;
  branding: object | null;
  checks: PublicCheck[];
}

@Injectable()
export class PublicStatusService {
  constructor(private readonly prisma: PrismaService) {}

  async getBySlug(slug: string): Promise<PublicStatusPage> {
    const page = await this.prisma.statusPage.findUnique({
      where: { slug },
      select: {
        title: true,
        branding: true,
        checkIds: true,
        projectId: true,
      },
    });

    if (!page) {
      throw new NotFoundException(`Status page "${slug}" not found`);
    }

    const branding: object | null =
      page.branding !== null &&
      typeof page.branding === 'object' &&
      !Array.isArray(page.branding)
        ? page.branding
        : null;

    const fetchedChecks: (PublicCheck & { id: string })[] =
      page.checkIds.length > 0
        ? await this.prisma.check.findMany({
            where: {
              id: { in: page.checkIds },
              projectId: page.projectId,
            },
            select: {
              id: true,
              name: true,
              status: true,
              lastEventAt: true,
            },
          })
        : [];

    // Reorder to match the author's intended check order in checkIds
    const checksById = new Map(fetchedChecks.map((c) => [c.id, c]));
    const checks: PublicCheck[] = page.checkIds
      .map((id) => checksById.get(id))
      .filter((c): c is PublicCheck & { id: string } => c !== undefined)
      .map(({ name, status, lastEventAt }) => ({ name, status, lastEventAt }));

    return { title: page.title, branding, checks };
  }
}
