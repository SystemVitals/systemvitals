import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@systemvitals/database';
import { PrismaService } from '../prisma/prisma.service';
import { AccountEntitlementsService } from '../billing/account-entitlements.service';
import { slugify } from '../common/slug';
import { createWithUniqueSlug } from '../common/create-with-unique-slug';
import { lockProjectCheckStatusChanges } from '../common/project-check-status-lock';
import { isValidCron, isValidTz, minCronGapSeconds } from './cron';
import {
  resolveCheckUpdate,
  CheckValidationError,
  type CheckUpdateInput,
} from './check-update';
import type { CheckModel } from './check.model';

const CREATOR_STABILITY_RETRIES = 3;

class CreatorChangedDuringCheckOperation extends Error {}

type LockedExpectedCheck = Prisma.CheckGetPayload<{
  include: { project: true };
}>;

export type CheckWithNotificationChannels<T> = T & {
  notificationChannelIds: string[];
};

@Injectable()
export class ChecksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: AccountEntitlementsService,
  ) {}

  private async assertMemberWith(
    db: Prisma.TransactionClient | PrismaService,
    userId: string,
    organizationId: string,
  ) {
    const m = await db.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
    });
    if (!m) throw new ForbiddenException('Not a member of this organization');
  }

  private async lockAndAssertMember(
    tx: Prisma.TransactionClient,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT id FROM memberships
      WHERE user_id = ${userId} AND organization_id = ${organizationId}
      FOR UPDATE
    `;
    await this.assertMemberWith(tx, userId, organizationId);
  }

  private async lockAndAssertOwner(
    tx: Prisma.TransactionClient,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT id FROM memberships
      WHERE user_id = ${userId} AND organization_id = ${organizationId}
      FOR UPDATE
    `;
    const membership = await tx.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { role: true },
    });
    if (membership?.role !== 'OWNER') {
      throw new ForbiddenException(
        'You must own both organizations to move this check',
      );
    }
  }

  private async removeCheckFromSourceStatusPages(
    tx: Prisma.TransactionClient,
    sourceProjectId: string,
    checkId: string,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT id FROM status_pages
      WHERE project_id = ${sourceProjectId}
      FOR UPDATE
    `;
    const pages = await tx.statusPage.findMany({
      where: { projectId: sourceProjectId, checkIds: { has: checkId } },
      select: { id: true, checkIds: true },
    });
    await Promise.all(
      pages.map((page) =>
        tx.statusPage.update({
          where: { id: page.id },
          data: { checkIds: page.checkIds.filter((id) => id !== checkId) },
        }),
      ),
    );
  }

  private async lockAndAssertExpectedCheck(
    tx: Prisma.TransactionClient,
    userId: string,
    checkId: string,
    expectedProjectId: string,
  ) {
    await tx.$queryRaw`
      SELECT id FROM checks WHERE id = ${checkId} FOR UPDATE
    `;
    const check = await tx.check.findUnique({
      where: { id: checkId },
      include: { project: true },
    });
    if (!check) throw new NotFoundException('Check not found');
    if (check.projectId !== expectedProjectId) {
      throw new ForbiddenException(
        'Check no longer belongs to the authorized project',
      );
    }
    await this.lockAndAssertMember(tx, userId, check.project.organizationId);
    return check;
  }

  private async withCreatorRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= CREATOR_STABILITY_RETRIES; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation);
      } catch (error) {
        if (!(error instanceof CreatorChangedDuringCheckOperation)) {
          throw error;
        }
        if (attempt === CREATOR_STABILITY_RETRIES) {
          throw new ConflictException(
            'Organization creator changed during the operation; please retry.',
          );
        }
      }
    }
    throw new Error('Unreachable creator retry state');
  }

  private async withCreatorStableExpectedCheck<T>(
    userId: string,
    checkId: string,
    expectedProjectId: string,
    operation: (
      tx: Prisma.TransactionClient,
      check: LockedExpectedCheck,
      creatorUserId: string,
    ) => Promise<T>,
  ): Promise<T> {
    return this.withCreatorRetry(async (tx) => {
      const initialCheck = await tx.check.findUnique({
        where: { id: checkId },
        include: {
          project: {
            include: {
              organization: { select: { creatorUserId: true } },
            },
          },
        },
      });
      if (!initialCheck) throw new NotFoundException('Check not found');
      if (initialCheck.projectId !== expectedProjectId) {
        throw new ForbiddenException(
          'Check no longer belongs to the authorized project',
        );
      }

      const initialCreatorId = initialCheck.project.organization.creatorUserId;

      // Shared mutation/deletion lock order:
      // creator account -> check row -> caller membership.
      // Organization deletion uses the same creator-first prefix before it
      // locks memberships and cascades to checks.
      await this.entitlements.lockUsers(tx, [initialCreatorId]);
      const stableProject = await tx.project.findUnique({
        where: { id: initialCheck.projectId },
        include: {
          organization: { select: { creatorUserId: true } },
        },
      });
      if (!stableProject) throw new NotFoundException('Check not found');
      if (stableProject.organization.creatorUserId !== initialCreatorId) {
        throw new CreatorChangedDuringCheckOperation();
      }

      const check = await this.lockAndAssertExpectedCheck(
        tx,
        userId,
        checkId,
        expectedProjectId,
      );
      return operation(tx, check, initialCreatorId);
    });
  }

  private async assertMember(userId: string, organizationId: string) {
    return this.assertMemberWith(this.prisma, userId, organizationId);
  }

  private async assertProjectAccess(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new ForbiddenException('Project not found');
    await this.assertMember(userId, project.organizationId);
    return project;
  }

  private async createWithinAccountQuota<T>(
    userId: string,
    projectId: string,
    intervalSeconds: number,
    create: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.withCreatorRetry(async (tx) => {
      const project = await tx.project.findUnique({
        where: { id: projectId },
        include: {
          organization: { select: { creatorUserId: true } },
        },
      });
      if (!project) throw new ForbiddenException('Project not found');
      await this.entitlements.lockUsers(tx, [
        project.organization.creatorUserId,
      ]);
      const stableProject = await tx.project.findUnique({
        where: { id: projectId },
        include: {
          organization: { select: { creatorUserId: true } },
        },
      });
      if (!stableProject) throw new ForbiddenException('Project not found');
      if (
        stableProject.organization.creatorUserId !==
        project.organization.creatorUserId
      ) {
        throw new CreatorChangedDuringCheckOperation();
      }
      await this.lockAndAssertMember(tx, userId, stableProject.organizationId);
      const account = await this.entitlements.forUser(
        tx,
        stableProject.organization.creatorUserId,
      );
      this.entitlements.assertInterval(account, intervalSeconds);
      this.entitlements.assertCanAddCheck(account);
      return create(tx);
    });
  }

  private async takenCheckSlugs(
    db: Prisma.TransactionClient | PrismaService,
    projectId: string,
  ): Promise<string[]> {
    const existing = await db.check.findMany({
      where: { projectId },
      select: { slug: true },
    });
    return existing.map((c) => c.slug);
  }

  private async assertCheckAccess(userId: string, checkId: string) {
    const check = await this.prisma.check.findUnique({
      where: { id: checkId },
      include: { project: true },
    });
    if (!check) throw new NotFoundException('Check not found');
    await this.assertMember(userId, check.project.organizationId);
    return check;
  }

  async create(
    userId: string,
    projectId: string,
    name: string,
    graceSeconds: number,
    periodSeconds?: number,
    schedule?: string,
    tz?: string,
  ) {
    const hasPeriod = typeof periodSeconds === 'number';
    const hasCron = typeof schedule === 'string' && schedule.length > 0;
    if (hasPeriod === hasCron) {
      throw new BadRequestException(
        'Provide exactly one of periodSeconds or schedule',
      );
    }

    if (hasCron) {
      if (!isValidCron(schedule)) {
        throw new BadRequestException('Invalid cron expression');
      }
      const zone = tz && tz.length ? tz : 'UTC';
      if (!isValidTz(zone)) throw new BadRequestException('Invalid timezone');
      return this.createWithinAccountQuota(
        userId,
        projectId,
        minCronGapSeconds(schedule, zone),
        (tx) =>
          createWithUniqueSlug({
            base: slugify(name),
            loadTakenSlugs: () => this.takenCheckSlugs(tx, projectId),
            entityLabel: 'check',
            create: (slug) =>
              tx.check.create({
                data: {
                  name,
                  slug,
                  type: 'HEARTBEAT',
                  status: 'NEW',
                  projectId,
                  pingSlug: randomUUID(),
                  graceSeconds,
                  schedule,
                  tz: zone,
                },
              }),
          }),
      );
    }

    return this.createWithinAccountQuota(
      userId,
      projectId,
      periodSeconds!,
      (tx) =>
        createWithUniqueSlug({
          base: slugify(name),
          loadTakenSlugs: () => this.takenCheckSlugs(tx, projectId),
          entityLabel: 'check',
          create: (slug) =>
            tx.check.create({
              data: {
                name,
                slug,
                type: 'HEARTBEAT',
                status: 'NEW',
                projectId,
                pingSlug: randomUUID(),
                periodSeconds,
                graceSeconds,
              },
            }),
        }),
    );
  }

  async list(userId: string, projectId: string) {
    await this.assertProjectAccess(userId, projectId);
    const checks = await this.prisma.check.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
    const [channels, exclusions] = await Promise.all([
      this.prisma.notificationChannel.findMany({
        where: { projectId, enabled: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      }),
      this.prisma.checkChannelExclusion.findMany({
        where: { checkId: { in: checks.map(({ id }) => id) } },
        select: { checkId: true, channelId: true },
      }),
    ]);
    const channelIds = channels.map(({ id }) => id);
    const excludedByCheck = new Map<string, Set<string>>();
    for (const { checkId, channelId } of exclusions) {
      const excluded = excludedByCheck.get(checkId) ?? new Set<string>();
      excluded.add(channelId);
      excludedByCheck.set(checkId, excluded);
    }

    return checks.map((check) => {
      const excluded = excludedByCheck.get(check.id);
      return {
        ...check,
        notificationChannelIds: excluded
          ? channelIds.filter((channelId) => !excluded.has(channelId))
          : [...channelIds],
      };
    });
  }

  async findOne(userId: string, checkId: string) {
    const check = await this.assertCheckAccess(userId, checkId);
    const notificationChannelIds = await this.effectiveNotificationChannelIds(
      check.id,
      check.projectId,
    );
    return {
      ...check,
      organizationId: check.project.organizationId,
      notificationChannelIds,
    };
  }

  async projectIdForCheck(userId: string, checkId: string): Promise<string> {
    const check = await this.assertCheckAccess(userId, checkId);
    return check.projectId;
  }

  async findBySlug(
    userId: string,
    orgSlug: string,
    projectSlug: string,
    checkSlug: string,
  ) {
    // A slug triple is guessable in a way a cuid is not. Answering "forbidden"
    // for another tenant's check would confirm it exists, so a check the
    // caller cannot see must be reported exactly as one that does not exist
    // — including in timing. The membership requirement is folded into this
    // single query (rather than a findFirst-then-membership.findUnique pair)
    // so that "exists but not mine" and "does not exist" do identical
    // database work and are indistinguishable by response latency. Do NOT
    // split this back into two queries.
    const check = await this.prisma.check.findFirst({
      where: {
        slug: checkSlug,
        project: {
          slug: projectSlug,
          organization: {
            slug: orgSlug,
            memberships: { some: { userId } },
          },
        },
      },
    });

    if (!check) throw new NotFoundException('Check not found');

    const notificationChannelIds = await this.effectiveNotificationChannelIds(
      check.id,
      check.projectId,
    );
    return { ...check, notificationChannelIds };
  }

  async findByOrganizationSlug(
    userId: string,
    orgSlug: string,
    checkSlug: string,
    boundProjectId?: string,
  ) {
    // Organization and check slugs are guessable. Fold membership into this
    // lookup, together with any credential project binding, so an inaccessible
    // check and a missing check perform the same database work and return the
    // same public error.
    const check = await this.prisma.check.findFirst({
      where: {
        slug: checkSlug,
        project: {
          ...(boundProjectId ? { id: boundProjectId } : {}),
          organization: {
            slug: orgSlug,
            memberships: { some: { userId } },
          },
        },
      },
      include: {
        project: { select: { organizationId: true } },
      },
    });

    if (!check) throw new NotFoundException('Check not found');

    const notificationChannelIds = await this.effectiveNotificationChannelIds(
      check.id,
      check.projectId,
    );
    return {
      ...check,
      organizationId: check.project.organizationId,
      notificationChannelIds,
    };
  }

  async effectiveNotificationChannelIds(
    checkId: string,
    projectId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    const client = tx ?? this.prisma;
    const channels = await client.notificationChannel.findMany({
      where: {
        projectId,
        enabled: true,
        checkExclusions: { none: { checkId } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return channels.map(({ id }) => id);
  }

  async setCheckChannelEnabled(
    userId: string,
    checkId: string,
    expectedProjectId: string,
    channelId: string,
    enabled: boolean,
  ): Promise<CheckModel> {
    return this.withCreatorStableExpectedCheck(
      userId,
      checkId,
      expectedProjectId,
      async (tx, check) => {
        await tx.$queryRaw`
          SELECT id FROM notification_channels
          WHERE id = ${channelId} AND project_id = ${check.projectId}
          FOR UPDATE
        `;
        const channel = await tx.notificationChannel.findFirst({
          where: { id: channelId, projectId: check.projectId },
          select: { id: true, enabled: true },
        });
        if (!channel) {
          throw new NotFoundException('Notification channel not found');
        }
        if (!channel.enabled) {
          throw new BadRequestException('Notification channel is not enabled');
        }

        if (enabled) {
          await tx.checkChannelExclusion.deleteMany({
            where: { checkId, channelId },
          });
        } else {
          await tx.checkChannelExclusion.upsert({
            where: {
              checkId_channelId: { checkId, channelId },
            },
            create: { checkId, channelId },
            update: {},
          });
        }

        const notificationChannelIds =
          await this.effectiveNotificationChannelIds(
            checkId,
            check.projectId,
            tx,
          );
        return {
          ...check,
          organizationId: check.project.organizationId,
          notificationChannelIds,
        } as CheckModel;
      },
    );
  }

  async update(
    userId: string,
    checkId: string,
    expectedProjectId: string,
    input: CheckUpdateInput,
  ) {
    try {
      return await this.withCreatorStableExpectedCheck(
        userId,
        checkId,
        expectedProjectId,
        async (tx, check, creatorUserId) => {
          let resolved;
          try {
            resolved = resolveCheckUpdate(check, input);
          } catch (err) {
            if (err instanceof CheckValidationError) {
              throw new BadRequestException(err.message);
            }
            throw err;
          }
          if (resolved.intervalToValidate !== null) {
            const account = await this.entitlements.forUser(tx, creatorUserId);
            this.entitlements.assertInterval(
              account,
              resolved.intervalToValidate,
            );
          }
          const data: Prisma.CheckUpdateInput = { ...resolved.data };
          if (resolved.mintPingSlug) data.pingSlug = randomUUID();
          return tx.check.update({ where: { id: checkId }, data });
        },
      );
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new BadRequestException(
          `A check with slug "${input.slug as string}" already exists in this project`,
        );
      }
      throw err;
    }
  }

  async move(userId: string, checkId: string, destinationProjectId: string) {
    try {
      return await this.withCreatorRetry(async (tx) => {
        const initialCheck = await tx.check.findUnique({
          where: { id: checkId },
          include: {
            project: {
              include: {
                organization: { select: { creatorUserId: true } },
              },
            },
          },
        });
        if (!initialCheck) throw new NotFoundException('Check not found');

        const initialDestination = await tx.project.findUnique({
          where: { id: destinationProjectId },
          include: {
            organization: { select: { creatorUserId: true } },
          },
        });
        if (!initialDestination) {
          throw new NotFoundException('Destination organization not found');
        }
        if (initialCheck.projectId === destinationProjectId) {
          throw new BadRequestException(
            'Check is already in the destination organization',
          );
        }
        if (
          initialCheck.project.organizationId ===
          initialDestination.organizationId
        ) {
          throw new BadRequestException(
            'Check is already in the destination organization',
          );
        }

        const sourceCreatorId = initialCheck.project.organization.creatorUserId;
        const destinationCreatorId =
          initialDestination.organization.creatorUserId;
        await this.entitlements.lockUsers(tx, [
          sourceCreatorId,
          destinationCreatorId,
        ]);
        await tx.$queryRaw`
          SELECT id FROM checks WHERE id = ${checkId} FOR UPDATE
        `;

        const check = await tx.check.findUnique({
          where: { id: checkId },
          include: {
            project: {
              include: {
                organization: { select: { creatorUserId: true } },
              },
            },
          },
        });
        const destination = await tx.project.findUnique({
          where: { id: destinationProjectId },
          include: {
            organization: { select: { creatorUserId: true } },
          },
        });
        if (!check) throw new NotFoundException('Check not found');
        if (!destination) {
          throw new NotFoundException('Destination organization not found');
        }
        if (
          check.project.organization.creatorUserId !== sourceCreatorId ||
          destination.organization.creatorUserId !== destinationCreatorId
        ) {
          throw new CreatorChangedDuringCheckOperation();
        }
        if (check.projectId === destinationProjectId) {
          throw new BadRequestException(
            'Check is already in the destination organization',
          );
        }
        if (check.project.organizationId === destination.organizationId) {
          throw new BadRequestException(
            'Check is already in the destination organization',
          );
        }

        await this.lockAndAssertOwner(tx, userId, check.project.organizationId);
        await this.lockAndAssertOwner(tx, userId, destination.organizationId);

        const collision = await tx.check.findFirst({
          where: {
            projectId: destinationProjectId,
            slug: check.slug,
            id: { not: check.id },
          },
          select: { id: true },
        });
        if (collision) {
          throw new ConflictException(
            `A check with slug "${check.slug}" already exists in the destination organization`,
          );
        }

        if (sourceCreatorId !== destinationCreatorId) {
          const destinationAccount = await this.entitlements.forUser(
            tx,
            destinationCreatorId,
          );
          this.entitlements.assertCanAddCheck(destinationAccount);
        }

        await lockProjectCheckStatusChanges(tx, [check.projectId]);
        await this.removeCheckFromSourceStatusPages(
          tx,
          check.projectId,
          check.id,
        );
        await tx.checkChannelExclusion.deleteMany({
          where: { checkId: check.id },
        });
        return tx.check.update({
          where: { id: check.id },
          data: { projectId: destinationProjectId },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'A check with this slug already exists in the destination organization',
        );
      }
      throw error;
    }
  }

  async pause(userId: string, checkId: string, expectedProjectId: string) {
    return this.withCreatorStableExpectedCheck(
      userId,
      checkId,
      expectedProjectId,
      (tx) =>
        tx.check.update({
          where: { id: checkId },
          data: { status: 'PAUSED' },
        }),
    );
  }

  async resume(userId: string, checkId: string, expectedProjectId: string) {
    return this.withCreatorStableExpectedCheck(
      userId,
      checkId,
      expectedProjectId,
      (tx) =>
        tx.check.update({
          where: { id: checkId },
          data: { status: 'NEW' },
        }),
    );
  }

  async delete(userId: string, checkId: string, expectedProjectId: string) {
    return this.withCreatorStableExpectedCheck(
      userId,
      checkId,
      expectedProjectId,
      async (tx) => {
        await tx.check.delete({ where: { id: checkId } });
        return true;
      },
    );
  }

  async createActiveCheck(
    userId: string,
    projectId: string,
    name: string,
    type: string,
    target: string,
    intervalSeconds: number,
    timeoutMs: number,
    method?: string,
    expectedStatus?: number,
  ) {
    if (type !== 'HTTP' && type !== 'TCP') {
      throw new BadRequestException(
        `Type must be HTTP or TCP; got ${type}. HEARTBEAT and PING are not accepted here.`,
      );
    }

    if (type === 'HTTP') {
      if (!target.startsWith('http://') && !target.startsWith('https://')) {
        throw new BadRequestException(
          'HTTP target must be a valid URL starting with http:// or https://',
        );
      }
    }

    if (type === 'TCP') {
      if (!target.includes(':')) {
        throw new BadRequestException('TCP target must be in host:port format');
      }
    }

    const resolvedMethod = type === 'HTTP' ? (method ?? 'GET') : method;
    return this.createWithinAccountQuota(
      userId,
      projectId,
      intervalSeconds,
      (tx) =>
        createWithUniqueSlug({
          base: slugify(name),
          loadTakenSlugs: () => this.takenCheckSlugs(tx, projectId),
          entityLabel: 'check',
          create: (slug) =>
            tx.check.create({
              data: {
                name,
                slug,
                type,
                status: 'NEW',
                projectId,
                target,
                intervalSeconds,
                timeoutMs,
                method: resolvedMethod,
                expectedStatus,
              },
            }),
        }),
    );
  }

  async eventsForCheck(checkId: string, limit: number) {
    return this.prisma.checkEvent.findMany({
      where: { checkId },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }
}
