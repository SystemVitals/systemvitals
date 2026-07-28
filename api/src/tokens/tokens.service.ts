import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { generateToken } from './token.util';
import type { CreateApiTokenInput } from './create-api-token.input';

const SCOPED_CAPABILITIES = ['checks:read', 'checks:write'] as const;
const LEGACY_SCOPES = ['read', 'write'] as const;
const TOKEN_SELECT = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  projectId: true,
  projectNameSnapshot: true,
  organizationNameSnapshot: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
  project: {
    select: {
      name: true,
      organization: { select: { name: true } },
    },
  },
} as const;

interface TokenWithProject {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  projectId: string | null;
  projectNameSnapshot: string | null;
  organizationNameSnapshot: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  project: {
    name: string;
    organization: { name: string };
  } | null;
}

@Injectable()
export class TokensService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, name: string, scopes: string[]) {
    if (
      scopes.some((scope) =>
        SCOPED_CAPABILITIES.includes(
          scope as (typeof SCOPED_CAPABILITIES)[number],
        ),
      )
    ) {
      throw new BadRequestException(
        'Check capabilities require a project-scoped token',
      );
    }
    if (
      scopes.length === 0 ||
      scopes.some(
        (scope) =>
          !LEGACY_SCOPES.includes(scope as (typeof LEGACY_SCOPES)[number]),
      )
    ) {
      throw new BadRequestException(
        'Legacy tokens support only read and write scopes',
      );
    }

    const { plaintext, prefix, hash } = generateToken();
    const token = await this.prisma.apiToken.create({
      data: { userId, name, prefix, scopes, tokenHash: hash },
      select: TOKEN_SELECT,
    });
    return { ...this.toModel(token), plaintext };
  }

  async createScoped(userId: string, input: CreateApiTokenInput) {
    const scopes = [...new Set(input.capabilities)].sort();
    if (
      scopes.length !== SCOPED_CAPABILITIES.length ||
      !SCOPED_CAPABILITIES.every((capability) => scopes.includes(capability))
    ) {
      throw new BadRequestException(
        `capabilities must contain exactly ${SCOPED_CAPABILITIES.join(', ')}`,
      );
    }

    const project = await this.prisma.project.findFirst({
      where: {
        id: input.projectId,
        organization: { memberships: { some: { userId } } },
      },
      select: {
        id: true,
        name: true,
        organization: { select: { name: true } },
      },
    });
    if (!project) {
      throw new ForbiddenException('Project is not accessible');
    }

    const expiresAt =
      input.expirationDays === undefined
        ? null
        : new Date(Date.now() + input.expirationDays * 24 * 60 * 60 * 1000);
    const { plaintext, prefix, hash } = generateToken();
    const token = await this.prisma.apiToken.create({
      data: {
        userId,
        name: input.name,
        prefix,
        scopes,
        tokenHash: hash,
        projectId: project.id,
        projectNameSnapshot: project.name,
        organizationNameSnapshot: project.organization.name,
        expiresAt,
      },
      select: TOKEN_SELECT,
    });
    return { ...this.toModel(token), plaintext };
  }

  async revoke(userId: string, id: string) {
    await this.prisma.apiToken.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return true;
  }

  list(userId: string) {
    return this.prisma.apiToken
      .findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: TOKEN_SELECT,
      })
      .then((tokens) => tokens.map((token) => this.toModel(token)));
  }

  private toModel(token: TokenWithProject) {
    return {
      id: token.id,
      name: token.name,
      prefix: token.prefix,
      scopes: token.scopes,
      projectId: token.projectId,
      projectName: token.project?.name ?? token.projectNameSnapshot,
      organizationName:
        token.project?.organization.name ?? token.organizationNameSnapshot,
      expiresAt: token.expiresAt,
      lastUsedAt: token.lastUsedAt,
      revokedAt: token.revokedAt,
      createdAt: token.createdAt,
    };
  }
}
