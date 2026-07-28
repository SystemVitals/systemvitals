import { Module } from '@nestjs/common';
import { AuthModule } from './auth.module';
import { AuthResolver } from './auth.resolver';

/**
 * Slim wrapper so AuthResolver reaches only the public GraphQL surface.
 *
 * AdminModule imports AuthModule directly (for AuthService, used by
 * signImpersonation) but must NOT pick up AuthResolver — the two GraphQL
 * surfaces (`/graphql` and `/admin/graphql`) are deliberately isolated (see
 * root CLAUDE.md). Registering AuthResolver on AuthModule itself would mount
 * it on both surfaces via AdminModule's import. This module carries the
 * resolver separately so only app.module.ts's public `include` array needs
 * it.
 */
@Module({
  imports: [AuthModule],
  providers: [AuthResolver],
})
export class AuthGraphqlModule {}
