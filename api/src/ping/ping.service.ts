import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@systemvitals/database';
import { PrismaService } from '../prisma/prisma.service';
import { AlertQueueService } from '../queue/alert-queue.service';

export interface PingResult {
  recovered: boolean;
  checkId: string;
}

type PingTransition =
  | { recovered: false }
  | { recovered: true; channelIds: string[] };

@Injectable()
export class PingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alertQueue: AlertQueueService,
  ) {}

  async recordPing(
    slug: string,
    sourceIp: string | null = null,
  ): Promise<PingResult> {
    const check = await this.prisma.check.findUnique({
      where: { pingSlug: slug },
    });

    // A `pingSlug` survives conversion away from HEARTBEAT (so converting
    // back restores the same ping URL) but must stay inert while the check
    // is a different type — otherwise a stale heartbeat caller could force
    // an HTTP/TCP check's status and reset the probe scheduler's due timer
    // via `lastEventAt`. Treat a non-HEARTBEAT owner identically to an
    // unknown slug: same 404, no mutation, no leak that the slug exists.
    if (!check || check.type !== 'HEARTBEAT') {
      throw new NotFoundException(`No check found for slug: ${slug}`);
    }

    let transition: PingTransition;
    try {
      transition = await this.prisma.$transaction(
        async (tx): Promise<PingTransition> => {
          await tx.$queryRaw`
          SELECT id FROM checks WHERE id = ${check.id} FOR UPDATE
        `;
          const lockedCheck = await tx.check.findUnique({
            where: { id: check.id },
          });
          if (!lockedCheck || lockedCheck.type !== 'HEARTBEAT') {
            throw new NotFoundException('Check not found');
          }

          const previousStatus = lockedCheck.status;
          const now = new Date();
          await tx.checkEvent.create({
            data: {
              checkId: lockedCheck.id,
              timestamp: now,
              status: 'UP',
              sourceIp,
            },
          });
          await tx.check.update({
            where: { id: lockedCheck.id },
            data: {
              status: 'UP',
              lastEventAt: now,
            },
          });

          if (previousStatus !== 'DOWN') {
            return { recovered: false };
          }
          const channels = await tx.notificationChannel.findMany({
            where: {
              projectId: lockedCheck.projectId,
              enabled: true,
              checkExclusions: { none: { checkId: lockedCheck.id } },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true },
          });
          return {
            recovered: true,
            channelIds: channels.map(({ id }) => id),
          };
        },
      );
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === 'P2025' || e.code === 'P2003')
      ) {
        throw new NotFoundException('Check not found');
      }
      throw e;
    }

    if (transition.recovered) {
      const enqueuePromise = this.alertQueue.enqueue({
        checkId: check.id,
        kind: 'recovery',
        channelIds: transition.channelIds,
      });
      void Promise.resolve(enqueuePromise).catch((err) =>
        console.error('recovery enqueue failed', err),
      );
    }

    return {
      recovered: transition.recovered,
      checkId: check.id,
    };
  }
}
