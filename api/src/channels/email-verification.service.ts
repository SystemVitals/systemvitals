import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Prisma } from '@systemvitals/database';
import { PrismaService } from '../prisma/prisma.service';
import { EmailVerificationQueueService } from '../queue/email-verification-queue.service';
import { presentChannel } from './channels.service';
import {
  createEmailVerificationToken,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  hashEmailVerificationToken,
  maskEmailDestination,
} from './email-verification-token';

export type EmailVerificationPreview =
  | {
      status: 'PENDING';
      maskedEmail: string;
      projectName: string;
      expiresAt: Date;
    }
  | { status: 'EXPIRED' | 'INVALID' };

export type EmailVerificationConfirmation =
  | {
      status: 'VERIFIED';
      maskedEmail: string;
      projectName: string;
    }
  | { status: 'EXPIRED' | 'INVALID' };

const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type TransactionClient = Prisma.TransactionClient;

function emailFromConfig(config: unknown): string {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return '';
  }
  const email = (config as Record<string, unknown>)['email'];
  return typeof email === 'string' ? email : '';
}

function tokenHashOrNull(rawToken: string): string | null {
  return RAW_TOKEN_PATTERN.test(rawToken)
    ? hashEmailVerificationToken(rawToken)
    : null;
}

@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: EmailVerificationQueueService,
  ) {}

  async preview(rawToken: string): Promise<EmailVerificationPreview> {
    const tokenHash = tokenHashOrNull(rawToken);
    if (!tokenHash) return { status: 'INVALID' };

    const channel = await this.prisma.notificationChannel.findUnique({
      where: { verificationTokenHash: tokenHash },
      include: { project: { select: { name: true } } },
    });
    if (!channel || channel.type !== 'EMAIL' || channel.verifiedAt) {
      return { status: 'INVALID' };
    }

    const expiresAt = channel.verificationExpiresAt;
    if (!expiresAt || expiresAt.getTime() <= Date.now()) {
      return { status: 'EXPIRED' };
    }

    return {
      status: 'PENDING',
      maskedEmail: maskEmailDestination(emailFromConfig(channel.config)),
      projectName: channel.project.name,
      expiresAt,
    };
  }

  async verify(rawToken: string): Promise<EmailVerificationConfirmation> {
    const tokenHash = tokenHashOrNull(rawToken);
    if (!tokenHash) return { status: 'INVALID' };

    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "notification_channels"
        WHERE "verification_token_hash" = ${tokenHash}
        FOR UPDATE
      `;
      const channelId = locked[0]?.id;
      if (!channelId) return { status: 'INVALID' as const };

      const channel = await tx.notificationChannel.findUnique({
        where: { id: channelId },
        include: { project: { select: { name: true } } },
      });
      if (!channel || channel.type !== 'EMAIL' || channel.verifiedAt) {
        return { status: 'INVALID' as const };
      }
      const now = new Date();
      if (
        !channel.verificationExpiresAt ||
        channel.verificationExpiresAt.getTime() <= now.getTime()
      ) {
        return { status: 'EXPIRED' as const };
      }

      const updated = await tx.notificationChannel.updateMany({
        where: {
          id: channel.id,
          verificationTokenHash: channel.verificationTokenHash,
          verifiedAt: null,
        },
        data: {
          enabled: true,
          verifiedAt: now,
          verificationTokenHash: null,
          verificationExpiresAt: null,
        },
      });
      if (updated.count !== 1) return { status: 'INVALID' as const };

      return {
        status: 'VERIFIED' as const,
        maskedEmail: maskEmailDestination(emailFromConfig(channel.config)),
        projectName: channel.project.name,
      };
    });
  }

  async resend(userId: string, channelId: string) {
    const rotated = await this.prisma.$transaction(async (tx) =>
      this.rotateToken(tx, userId, channelId),
    );

    try {
      await this.queue.enqueue({
        channelId: rotated.channel.id,
        rawToken: rotated.rawToken,
      });
    } catch {
      const cleared = await this.prisma.notificationChannel.updateMany({
        where: {
          id: rotated.channel.id,
          verificationTokenHash: rotated.tokenHash,
          verificationSentAt: rotated.reservedAt,
        },
        data: { verificationSentAt: null },
      });
      if (cleared.count === 1) {
        return presentChannel({
          ...rotated.channel,
          verificationSentAt: null,
        });
      }

      const current = await this.prisma.notificationChannel.findUnique({
        where: { id: rotated.channel.id },
      });
      if (!current) {
        throw new ConflictException(
          'A newer email verification request has replaced this one',
        );
      }
      return presentChannel(current);
    }

    const sentAt = new Date();
    const acknowledged = await this.prisma.notificationChannel.updateMany({
      where: {
        id: rotated.channel.id,
        verificationTokenHash: rotated.tokenHash,
        verificationSentAt: rotated.reservedAt,
      },
      data: { verificationSentAt: sentAt },
    });
    if (acknowledged.count !== 1) {
      throw new ConflictException(
        'A newer email verification request has replaced this one',
      );
    }

    return presentChannel({
      ...rotated.channel,
      verificationSentAt: sentAt,
    });
  }

  private async rotateToken(
    tx: TransactionClient,
    userId: string,
    channelId: string,
  ) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "notification_channels"
      WHERE "id" = ${channelId}
      FOR UPDATE
    `;
    if (!locked[0]?.id) {
      throw new ForbiddenException('Channel is unavailable');
    }

    const channel = await tx.notificationChannel.findUnique({
      where: { id: channelId },
      include: { project: true },
    });
    if (!channel) {
      throw new ForbiddenException('Channel is unavailable');
    }

    const membership = await tx.membership.findUnique({
      where: {
        userId_organizationId: {
          userId,
          organizationId: channel.project.organizationId,
        },
      },
    });
    if (!membership) {
      throw new ForbiddenException('Channel is unavailable');
    }
    if (channel.type !== 'EMAIL') {
      throw new BadRequestException(
        'Channel does not require email verification',
      );
    }
    if (channel.verifiedAt) {
      throw new BadRequestException('Email channel is already verified');
    }

    const now = new Date();
    if (
      channel.verificationSentAt &&
      now.getTime() - channel.verificationSentAt.getTime() <
        EMAIL_VERIFICATION_RESEND_COOLDOWN_MS
    ) {
      throw new ConflictException(
        'Email verification was sent less than 60 seconds ago',
      );
    }

    const token = createEmailVerificationToken(now);
    const updated = await tx.notificationChannel.update({
      where: { id: channel.id },
      data: {
        enabled: false,
        verificationTokenHash: token.tokenHash,
        verificationExpiresAt: token.expiresAt,
        verificationSentAt: now,
      },
    });

    return {
      channel: updated,
      rawToken: token.rawToken,
      tokenHash: token.tokenHash,
      reservedAt: now,
    };
  }
}
