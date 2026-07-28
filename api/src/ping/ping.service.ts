import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@systemvitals/database';
import { PrismaService } from '../prisma/prisma.service';
import { AlertQueueService } from '../queue/alert-queue.service';

export interface PingResult {
  recovered: boolean;
  checkId: string;
}

@Injectable()
export class PingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alertQueue: AlertQueueService,
  ) {}

  async recordPing(slug: string): Promise<PingResult> {
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

    const previousStatus = check.status;
    const now = new Date();

    try {
      await this.prisma.$transaction([
        this.prisma.checkEvent.create({
          data: {
            checkId: check.id,
            timestamp: now,
            status: 'UP',
          },
        }),
        this.prisma.check.update({
          where: { id: check.id },
          data: {
            status: 'UP',
            lastEventAt: now,
          },
        }),
      ]);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === 'P2025' || e.code === 'P2003')
      ) {
        throw new NotFoundException('Check not found');
      }
      throw e;
    }

    const recovered = previousStatus === 'DOWN';

    if (recovered) {
      const enqueuePromise = this.alertQueue.enqueue({
        checkId: check.id,
        kind: 'recovery',
      });
      void Promise.resolve(enqueuePromise).catch((err) =>
        console.error('recovery enqueue failed', err),
      );
    }

    return {
      recovered,
      checkId: check.id,
    };
  }
}
