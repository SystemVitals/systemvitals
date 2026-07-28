// api-token.strategy.ts — accepts JWT OR svt_ bearer tokens
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { hashToken } from './token.util';
import type { ApiPrincipal, TokenCapability } from './api-principal';
import type { Prisma } from '@systemvitals/database';

const TOKEN_CAPABILITIES: readonly TokenCapability[] = [
  'checks:read',
  'checks:write',
];
const LEGACY_SCOPES = ['read', 'write'] as const;

function isTokenCapability(scope: string): scope is TokenCapability {
  return TOKEN_CAPABILITIES.includes(scope as TokenCapability);
}

function isLegacyScope(scope: string): scope is (typeof LEGACY_SCOPES)[number] {
  return LEGACY_SCOPES.includes(scope as (typeof LEGACY_SCOPES)[number]);
}

@Injectable()
export class ApiTokenStrategy extends PassportStrategy(Strategy, 'api') {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {
    super();
  }

  private async validateApiToken(value: string): Promise<ApiPrincipal> {
    return this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const candidate = await tx.apiToken.findUnique({
          where: { tokenHash: hashToken(value) },
          select: { id: true, userId: true, projectId: true },
        });
        if (!candidate) throw new UnauthorizedException();

        await tx.$queryRaw`
          SELECT id FROM users WHERE id = ${candidate.userId} FOR UPDATE
        `;
        if (candidate.projectId !== null) {
          // Organization deletion reaches memberships before cascading to
          // projects. Keep authentication in that same global order:
          // user -> membership -> project -> token.
          await tx.$queryRaw`
            SELECT membership.id
            FROM memberships AS membership
            JOIN projects AS project
              ON project.organization_id = membership.organization_id
            WHERE membership.user_id = ${candidate.userId}
              AND project.id = ${candidate.projectId}
            FOR UPDATE OF membership
          `;
          await tx.$queryRaw`
            SELECT id FROM projects
            WHERE id = ${candidate.projectId}
            FOR UPDATE
          `;
        }
        await tx.$queryRaw`
          SELECT id FROM api_tokens WHERE id = ${candidate.id} FOR UPDATE
        `;

        const token = await tx.apiToken.findUnique({
          where: { id: candidate.id },
          include: {
            user: true,
            project: {
              select: {
                organization: {
                  select: {
                    memberships: {
                      where: { userId: candidate.userId },
                      select: { id: true },
                      take: 1,
                    },
                  },
                },
              },
            },
          },
        });
        if (!token) throw new UnauthorizedException();

        const now = new Date(Date.now());
        if (token.revokedAt) {
          throw new UnauthorizedException('Credential revoked');
        }
        if (token.expiresAt && token.expiresAt.getTime() <= now.getTime()) {
          throw new UnauthorizedException('Credential expired');
        }
        if (token.user.suspendedAt) {
          throw new UnauthorizedException('Credential owner account suspended');
        }
        if (token.projectId === null && token.projectNameSnapshot !== null) {
          throw new UnauthorizedException(
            'Credential project no longer exists',
          );
        }
        if (token.projectId === null && token.scopes.some(isTokenCapability)) {
          throw new UnauthorizedException(
            'Scoped credential is missing a project binding',
          );
        }
        if (token.projectId === null && !token.scopes.some(isLegacyScope)) {
          throw new UnauthorizedException('Credential has no supported scope');
        }
        if (
          token.projectId !== null &&
          (!token.project ||
            token.project.organization.memberships.length === 0)
        ) {
          throw new UnauthorizedException(
            'Credential project is no longer accessible',
          );
        }

        const touch = await tx.apiToken.updateMany({
          where: {
            id: token.id,
            projectId: token.projectId,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          data: { lastUsedAt: now },
        });
        if (touch.count !== 1) {
          throw new UnauthorizedException(
            'Credential became inactive during authentication',
          );
        }

        return {
          userId: token.userId,
          email: token.user.email,
          authKind: 'api-token' as const,
          apiToken: {
            id: token.id,
            projectId: token.projectId,
            capabilities: token.scopes.filter(isTokenCapability),
            legacyScopes: token.scopes.filter(isLegacyScope),
          },
        };
      },
      { timeout: 15_000 },
    );
  }

  async validate(req: FastifyRequest): Promise<ApiPrincipal> {
    const header = req.headers.authorization ?? '';
    const value = header.replace(/^Bearer\s+/i, '');
    if (!value) throw new UnauthorizedException();

    if (value.startsWith('svt_')) {
      return this.validateApiToken(value);
    }

    let payload: { sub: string; email: string; act?: string };
    try {
      payload = this.jwt.verify<{ sub: string; email: string; act?: string }>(
        value,
      );
    } catch {
      throw new UnauthorizedException();
    }
    const u = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { suspendedAt: true },
    });
    if (!u || u.suspendedAt)
      throw new UnauthorizedException('Account suspended');
    return {
      userId: payload.sub,
      email: payload.email,
      impersonatedBy: payload.act,
      authKind: 'session',
    };
  }
}
