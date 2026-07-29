import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import type { JwtUser } from '../auth/jwt.strategy';
import type { ApiPrincipal } from './api-principal';
import { ApiAuthGuard } from './api-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { TokensService } from './tokens.service';
import {
  ApiCredential,
  ApiTokenCreateResult,
  ApiTokenModel,
} from './token.model';
import { CreateApiTokenInput } from './create-api-token.input';

@Resolver()
export class ApiCredentialResolver {
  constructor(private readonly prisma: PrismaService) {}

  @Query(() => ApiCredential)
  @UseGuards(ApiAuthGuard)
  async apiCredential(
    @CurrentUser() principal: ApiPrincipal,
  ): Promise<ApiCredential> {
    if (principal.authKind === 'session') {
      return {
        authKind: 'session',
        credentialMode: 'SESSION',
        capabilities: [],
        organizationId: null,
        organizationName: null,
        projectId: null,
        projectName: null,
      };
    }

    const capabilities = new Set(principal.apiToken.capabilities);
    if (principal.apiToken.legacyScopes.includes('read')) {
      capabilities.add('checks:read');
    }
    if (principal.apiToken.legacyScopes.includes('write')) {
      capabilities.add('checks:read');
      capabilities.add('checks:write');
    }
    const projectId = principal.apiToken.projectId;
    const usesExplicitCheckCapabilities =
      principal.apiToken.capabilities.length > 0;
    const usesLegacyScopes = principal.apiToken.legacyScopes.some(
      (scope) => scope === 'read' || scope === 'write',
    );
    const credentialMode =
      projectId === null && !usesExplicitCheckCapabilities && usesLegacyScopes
        ? 'LEGACY_BROAD'
        : 'PROJECT_SCOPED';
    const project =
      projectId === null
        ? null
        : await this.prisma.project.findUnique({
            where: { id: projectId },
            select: {
              name: true,
              organizationId: true,
              organization: { select: { name: true } },
            },
          });

    return {
      authKind: 'api-token',
      credentialMode,
      capabilities: [...capabilities].sort(),
      organizationId: project?.organizationId ?? null,
      organizationName: project?.organization.name ?? null,
      projectId,
      projectName: project?.name ?? null,
    };
  }
}

@Resolver()
@UseGuards(JwtAuthGuard)
export class TokensResolver {
  constructor(private readonly tokens: TokensService) {}

  @Query(() => [ApiTokenModel])
  apiTokens(@CurrentUser() user: JwtUser) {
    return this.tokens.list(user.userId);
  }

  @Mutation(() => ApiTokenCreateResult)
  createApiToken(
    @CurrentUser() user: JwtUser,
    @Args('name') name: string,
    @Args('scopes', { type: () => [String] }) scopes: string[],
  ) {
    return this.tokens.create(user.userId, name, scopes);
  }

  @Mutation(() => ApiTokenCreateResult)
  createScopedApiToken(
    @CurrentUser() user: JwtUser,
    @Args('input') input: CreateApiTokenInput,
  ) {
    return this.tokens.createScoped(user.userId, input);
  }

  @Mutation(() => Boolean)
  revokeApiToken(
    @CurrentUser() user: JwtUser,
    @Args('id', { type: () => ID }) id: string,
  ) {
    return this.tokens.revoke(user.userId, id);
  }
}
