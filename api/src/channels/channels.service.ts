import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@systemvitals/database';
import { PrismaService } from '../prisma/prisma.service';
import { EmailVerificationQueueService } from '../queue/email-verification-queue.service';
import {
  createEmailVerificationToken,
  normalizeEmailDestination,
} from './email-verification-token';

const VALID_CHANNEL_TYPES = ['EMAIL', 'SLACK', 'TELEGRAM', 'WEBHOOK'] as const;
type ChannelType = (typeof VALID_CHANNEL_TYPES)[number];

function isValidChannelType(type: string): type is ChannelType {
  return (VALID_CHANNEL_TYPES as readonly string[]).includes(type);
}

/**
 * Returns only scheme+host from a URL string, hiding the secret path/token.
 * e.g. "https://hooks.slack.com/services/SECRET" → "https://hooks.slack.com/…"
 * Falls back to "…" if the input is not a parseable URL.
 */
function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '…';
  }
}

/** Safely coerce an unknown config value to string, defaulting to ''. */
function toStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function toConfigRecord(config: unknown): Record<string, unknown> {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return {};
  }
  return config as Record<string, unknown>;
}

function sanitizeEmailConfig(config: Record<string, unknown>): {
  email: string;
} {
  try {
    return { email: normalizeEmailDestination(toStr(config['email'])) };
  } catch {
    return { email: '' };
  }
}

/**
 * Returns a sanitized version of the channel config suitable for returning to
 * clients — secrets (botToken, webhook URL paths) are stripped or masked.
 */
function sanitizeConfig(
  type: string,
  config: unknown,
): Record<string, unknown> {
  const cfg = toConfigRecord(config);
  switch (type) {
    case 'EMAIL':
      return sanitizeEmailConfig(cfg);
    case 'SLACK':
      return { webhookUrl: maskUrl(toStr(cfg['webhookUrl'])) };
    case 'TELEGRAM': {
      const chatType = cfg['chatType'];
      const chatTitle = cfg['chatTitle'];
      const messageThreadId = cfg['messageThreadId'];
      return {
        mode: typeof cfg['botToken'] === 'string' ? 'LEGACY' : 'MANAGED',
        chatId: toStr(cfg['chatId']),
        ...(typeof chatType === 'string' ? { chatType } : {}),
        ...(typeof chatTitle === 'string' ? { chatTitle } : {}),
        ...(typeof messageThreadId === 'number' ? { messageThreadId } : {}),
      };
    }
    case 'WEBHOOK':
      return { url: maskUrl(toStr(cfg['url'])) };
    default:
      return {};
  }
}

export function presentChannel(channel: {
  id: string;
  type: string;
  config: unknown;
  enabled: boolean;
  projectId: string;
  verifiedAt?: Date | null;
  verificationExpiresAt?: Date | null;
  verificationSentAt?: Date | null;
}) {
  const verificationStatus =
    channel.type !== 'EMAIL'
      ? ('NOT_REQUIRED' as const)
      : channel.verifiedAt
        ? ('VERIFIED' as const)
        : ('PENDING' as const);

  return {
    id: channel.id,
    type: channel.type,
    configJson: JSON.stringify(sanitizeConfig(channel.type, channel.config)),
    enabled: channel.enabled,
    projectId: channel.projectId,
    verificationStatus,
    verificationExpiresAt:
      channel.type === 'EMAIL' && !channel.verifiedAt
        ? (channel.verificationExpiresAt ?? null)
        : null,
    verificationDeliveryStatus:
      channel.type !== 'EMAIL'
        ? ('NOT_REQUIRED' as const)
        : channel.verificationSentAt
          ? ('SENT' as const)
          : ('NOT_SENT' as const),
  };
}

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailVerificationQueue: EmailVerificationQueueService,
  ) {}

  private async assertProjectAccess(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new ForbiddenException('Project not found');

    const m = await this.prisma.membership.findUnique({
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

  private async assertChannelAccess(userId: string, channelId: string) {
    const channel = await this.prisma.notificationChannel.findUnique({
      where: { id: channelId },
      include: { project: true },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const m = await this.prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId,
          organizationId: channel.project.organizationId,
        },
      },
    });
    if (!m) throw new ForbiddenException('Not a member of this organization');
    return channel;
  }

  private requireString(
    cfg: Record<string, unknown>,
    key: string,
    type: string,
  ): void {
    if (!cfg[key] || typeof cfg[key] !== 'string') {
      throw new BadRequestException(
        `${type} channel requires config.${key} to be a non-empty string`,
      );
    }
  }

  private validateConfig(type: string, cfg: Record<string, unknown>): void {
    switch (type) {
      case 'EMAIL':
        this.requireString(cfg, 'email', type);
        break;
      case 'SLACK':
        this.requireString(cfg, 'webhookUrl', type);
        break;
      case 'WEBHOOK':
        this.requireString(cfg, 'url', type);
        break;
    }
  }

  private parseAndValidateConfig(
    type: string,
    configJson: string,
  ): Prisma.InputJsonValue {
    let config: unknown;
    try {
      config = JSON.parse(configJson) as unknown;
    } catch {
      throw new BadRequestException('configJson must be valid JSON');
    }

    if (
      typeof config !== 'object' ||
      config === null ||
      Array.isArray(config)
    ) {
      throw new BadRequestException('configJson must be a JSON object');
    }

    const cfg = config as Record<string, unknown>;

    this.validateConfig(type, cfg);

    return config;
  }

  async create(
    userId: string,
    projectId: string,
    type: string,
    configJson: string,
  ) {
    if (!isValidChannelType(type)) {
      throw new BadRequestException(
        `Invalid channel type: ${type}. Must be one of: ${VALID_CHANNEL_TYPES.join(', ')}`,
      );
    }
    if (type === 'TELEGRAM') {
      throw new BadRequestException(
        'Telegram channels require the managed bot connection flow',
      );
    }

    await this.assertProjectAccess(userId, projectId);

    let config = this.parseAndValidateConfig(type, configJson);
    let verification:
      | ReturnType<typeof createEmailVerificationToken>
      | undefined;
    if (type === 'EMAIL') {
      const email = toStr(toConfigRecord(config)['email']);
      try {
        config = { email: normalizeEmailDestination(email) };
      } catch {
        throw new BadRequestException('Invalid email destination');
      }
      verification = createEmailVerificationToken(new Date());
    }

    let channel = await this.prisma.notificationChannel.create({
      data: {
        projectId,
        type,
        config,
        enabled: type !== 'EMAIL',
        verifiedAt: null,
        ...(verification
          ? {
              verificationTokenHash: verification.tokenHash,
              verificationExpiresAt: verification.expiresAt,
              verificationSentAt: null,
            }
          : {}),
      },
    });

    if (verification) {
      try {
        await this.emailVerificationQueue.enqueue({
          channelId: channel.id,
          rawToken: verification.rawToken,
        });
      } catch {
        return presentChannel(channel);
      }

      const sentAt = new Date();
      const acknowledged = await this.prisma.notificationChannel.updateMany({
        where: {
          id: channel.id,
          verificationTokenHash: verification.tokenHash,
        },
        data: { verificationSentAt: sentAt },
      });
      if (acknowledged.count === 1) {
        channel = { ...channel, verificationSentAt: sentAt };
      } else {
        const current = await this.prisma.notificationChannel.findUnique({
          where: { id: channel.id },
        });
        if (!current) {
          throw new ConflictException(
            'Email channel changed while verification was queued',
          );
        }
        channel = current;
      }
    }

    return presentChannel(channel);
  }

  async list(userId: string, projectId: string) {
    await this.assertProjectAccess(userId, projectId);

    const channels = await this.prisma.notificationChannel.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });

    return channels.map(presentChannel);
  }

  async delete(userId: string, channelId: string): Promise<boolean> {
    await this.assertChannelAccess(userId, channelId);
    await this.prisma.notificationChannel.delete({ where: { id: channelId } });
    return true;
  }
}
