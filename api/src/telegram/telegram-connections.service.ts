import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import type { TelegramConnectionChallenge } from '@systemvitals/database';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramBotClient } from './telegram-bot.client';
import type { TelegramStartUpdate } from './telegram-update';

export const TELEGRAM_CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const TELEGRAM_CHALLENGES_PER_MINUTE = 6;
export const TELEGRAM_PENDING_DELIVERY_LEASE_MS = 30_000;

const RECENT_CHALLENGE_WINDOW_MS = 60 * 1000;
const EXPIRED_CHALLENGE_RETENTION_MS = 24 * 60 * 60 * 1000;
const REPLY_PREFIX =
  'Connect this destination to SystemVitals (expires in 10 minutes):\n';
const DUPLICATE_UPDATE_TARGETS = new Set([
  'telegramupdateid',
  'telegramconnectionchallengestelegramupdateidkey',
]);
const CHALLENGE_TRANSACTION_TIMEOUT_MS = 5_000;
const CONNECTION_TRANSACTION_TIMEOUT_MS = 10_000;

type ChallengeClaim =
  | { kind: 'duplicate-delivered' }
  | { kind: 'pending-active' }
  | { kind: 'throttled' }
  | { kind: 'issue'; id: string; rawToken: string };

@Injectable()
export class TelegramConnectionsService {
  private readonly appOrigin: string;
  private cleanupInFlight: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegramBot: TelegramBotClient,
    config: ConfigService,
  ) {
    const isProduction = config.get<string>('NODE_ENV') === 'production';
    const configuredAppUrl = config.get<string>('APP_URL');
    const appUrl =
      configuredAppUrl ?? (isProduction ? null : 'http://localhost:9999');
    if (appUrl === null) {
      throw new Error('APP_URL configuration is invalid');
    }

    let parsed: URL;
    try {
      parsed = new URL(appUrl);
    } catch {
      throw new Error('APP_URL configuration is invalid');
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      (isProduction && parsed.protocol !== 'https:') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      throw new Error('APP_URL configuration is invalid');
    }
    this.appOrigin = parsed.origin;
  }

  async preview(rawToken: string) {
    const tokenHash = this.hashToken(rawToken);
    const challenge = await this.prisma.telegramConnectionChallenge.findUnique({
      where: { tokenHash },
    });
    const valid = this.requireUsableChallenge(challenge, new Date());

    return {
      chatId: valid.chatId,
      chatType: valid.chatType,
      chatTitle: valid.chatTitle,
      messageThreadId: valid.messageThreadId ?? null,
      expiresAt: valid.expiresAt,
    };
  }

  async connect(userId: string, rawToken: string, projectId: string) {
    const tokenHash = this.hashToken(rawToken);

    return this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "telegram_connection_challenges"
          WHERE "token_hash" = ${tokenHash}
          FOR UPDATE
        `;
        const challengeId = locked[0]?.id;
        if (!challengeId) {
          this.requireUsableChallenge(null, new Date());
        }

        const challenge = await tx.telegramConnectionChallenge.findUnique({
          where: { id: challengeId },
        });
        const valid = this.requireUsableChallenge(challenge, new Date());

        const project = await tx.project.findUnique({
          where: { id: projectId },
        });
        if (!project) {
          throw new ForbiddenException('Project not found');
        }

        const memberships = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "memberships"
          WHERE "user_id" = ${userId}
            AND "organization_id" = ${project.organizationId}
          FOR UPDATE
        `;
        if (!memberships[0]?.id) {
          throw new ForbiddenException('Not a member of this organization');
        }

        const topic = valid.messageThreadId;
        const destinationKey = `chat:${valid.chatId}:topic:${topic ?? 'root'}`;
        const config = {
          mode: 'MANAGED',
          chatId: valid.chatId,
          chatType: valid.chatType,
          ...(valid.chatTitle ? { chatTitle: valid.chatTitle } : {}),
          ...(topic !== null ? { messageThreadId: topic } : {}),
        };

        let channel;
        try {
          channel = await tx.notificationChannel.create({
            data: {
              projectId,
              type: 'TELEGRAM',
              destinationKey,
              config,
              enabled: true,
            },
          });
        } catch (error) {
          if (this.isDestinationConflict(error)) {
            throw new ConflictException(
              'This Telegram destination is already connected to that project',
            );
          }
          throw error;
        }

        await tx.telegramConnectionChallenge.update({
          where: { id: valid.id },
          data: { consumedAt: new Date() },
        });

        return {
          id: channel.id,
          type: channel.type,
          configJson: JSON.stringify(config),
          enabled: channel.enabled,
          organizationId: project.organizationId,
          projectId: channel.projectId,
        };
      },
      { timeout: CONNECTION_TRANSACTION_TIMEOUT_MS },
    );
  }

  async handleStart(update: TelegramStartUpdate): Promise<void> {
    const now = new Date();
    this.startCleanup(now);

    let claim: ChallengeClaim;
    try {
      claim = await this.claimChallenge(update, now);
    } catch (error) {
      if (!this.isDuplicateUpdateError(error)) {
        throw error;
      }
      claim = await this.claimChallenge(update, now);
    }
    if (claim.kind === 'pending-active') {
      throw new Error('Telegram challenge delivery in progress');
    }
    if (claim.kind !== 'issue') {
      return;
    }

    const connectUrl = new URL('/channels/telegram/connect', this.appOrigin);
    connectUrl.searchParams.set('token', claim.rawToken);
    const text = `${REPLY_PREFIX}${connectUrl.toString()}`;
    try {
      await this.telegramBot.sendMessage({
        chatId: update.chatId,
        messageThreadId: update.messageThreadId,
        text,
      });
    } catch {
      try {
        await this.prisma.telegramConnectionChallenge.delete({
          where: { id: claim.id },
        });
      } catch {
        // The outward error remains sanitized even if best-effort rollback fails.
      }
      throw new Error('Telegram challenge reply failed');
    }

    try {
      const marked = await this.prisma.telegramConnectionChallenge.updateMany({
        where: {
          id: claim.id,
          deliveredAt: null,
        },
        data: { deliveredAt: new Date() },
      });
      if (marked.count !== 1) {
        throw new Error('Delivery row was not pending');
      }
    } catch {
      throw new Error('Telegram challenge delivery confirmation failed');
    }
  }

  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  private requireUsableChallenge(
    challenge: TelegramConnectionChallenge | null,
    now: Date,
  ): TelegramConnectionChallenge {
    if (challenge === null) {
      throw new BadRequestException('This Telegram connection link is invalid');
    }
    if (challenge.deliveredAt === null) {
      throw new BadRequestException(
        'This Telegram connection link is not ready',
      );
    }
    if (challenge.consumedAt !== null) {
      throw new BadRequestException(
        'This Telegram connection link has already been used',
      );
    }
    if (challenge.expiresAt <= now) {
      throw new BadRequestException(
        'This Telegram connection link has expired',
      );
    }
    return challenge;
  }

  private async claimChallenge(
    update: TelegramStartUpdate,
    now: Date,
  ): Promise<ChallengeClaim> {
    const messageThreadId = update.messageThreadId ?? null;
    const destinationLockKey =
      messageThreadId === null
        ? `telegram-challenge:${update.chatId}:root`
        : `telegram-challenge:${update.chatId}:topic:${messageThreadId}`;

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${destinationLockKey}, 0)
          )::text AS "lock"
        `;

        const existing = await tx.telegramConnectionChallenge.findUnique({
          where: { telegramUpdateId: update.updateId },
          select: { id: true, deliveredAt: true, createdAt: true },
        });
        if (existing !== null && existing.deliveredAt !== null) {
          return { kind: 'duplicate-delivered' };
        }
        if (existing !== null) {
          const pendingCutoff = new Date(
            now.getTime() - TELEGRAM_PENDING_DELIVERY_LEASE_MS,
          );
          if (existing.createdAt > pendingCutoff) {
            return { kind: 'pending-active' };
          }
          await tx.telegramConnectionChallenge.delete({
            where: { id: existing.id },
          });
        }

        const recentCount = await tx.telegramConnectionChallenge.count({
          where: {
            chatId: update.chatId,
            messageThreadId,
            createdAt: {
              gte: new Date(now.getTime() - RECENT_CHALLENGE_WINDOW_MS),
            },
          },
        });
        if (recentCount >= TELEGRAM_CHALLENGES_PER_MINUTE) {
          return { kind: 'throttled' };
        }

        const rawToken = randomBytes(32).toString('base64url');
        const tokenHash = createHash('sha256').update(rawToken).digest('hex');
        const created = await tx.telegramConnectionChallenge.create({
          data: {
            tokenHash,
            telegramUpdateId: update.updateId,
            chatId: update.chatId,
            chatType: update.chatType,
            chatTitle: update.chatTitle,
            messageThreadId,
            expiresAt: new Date(now.getTime() + TELEGRAM_CHALLENGE_TTL_MS),
            deliveredAt: null,
          },
        });
        return { kind: 'issue', id: created.id, rawToken };
      },
      { timeout: CHALLENGE_TRANSACTION_TIMEOUT_MS },
    );
  }

  private startCleanup(now: Date): void {
    if (this.cleanupInFlight !== null) {
      return;
    }

    const cleanup = this.cleanupExpiredChallenges(now);
    this.cleanupInFlight = cleanup;
    const clear = () => {
      if (this.cleanupInFlight === cleanup) {
        this.cleanupInFlight = null;
      }
    };
    void cleanup.then(clear, clear);
  }

  private async cleanupExpiredChallenges(now: Date): Promise<void> {
    try {
      await this.prisma.telegramConnectionChallenge.deleteMany({
        where: {
          expiresAt: {
            lt: new Date(now.getTime() - EXPIRED_CHALLENGE_RETENTION_MS),
          },
        },
      });
    } catch {
      // Opportunistic cleanup must not prevent a new challenge.
    }
  }

  private isDuplicateUpdateError(error: unknown): boolean {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'P2002' ||
      !('meta' in error) ||
      typeof error.meta !== 'object' ||
      error.meta === null ||
      !('target' in error.meta)
    ) {
      return false;
    }

    const targets = Array.isArray(error.meta.target)
      ? error.meta.target
      : [error.meta.target];
    return (
      targets.length > 0 &&
      targets.every(
        (target) =>
          typeof target === 'string' &&
          DUPLICATE_UPDATE_TARGETS.has(
            target.replace(/[^a-z0-9]/gi, '').toLowerCase(),
          ),
      )
    );
  }

  private isDestinationConflict(error: unknown): boolean {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'P2002' ||
      !('meta' in error) ||
      typeof error.meta !== 'object' ||
      error.meta === null ||
      !('target' in error.meta)
    ) {
      return false;
    }

    const target = error.meta.target;
    if (typeof target === 'string') {
      return (
        target === 'notification_channels_project_id_type_destination_key_key'
      );
    }
    if (!Array.isArray(target)) {
      return false;
    }
    const normalized = target.map((field) =>
      typeof field === 'string' ? field.replace(/_/g, '').toLowerCase() : '',
    );
    return (
      normalized.length === 3 &&
      normalized[0] === 'projectid' &&
      normalized[1] === 'type' &&
      normalized[2] === 'destinationkey'
    );
  }
}
