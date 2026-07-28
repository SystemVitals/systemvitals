import { Module } from '@nestjs/common';
import { ApiCredentialResolver, TokensResolver } from './tokens.resolver';
import { TokensCoreModule } from './tokens-core.module';

@Module({
  imports: [TokensCoreModule],
  providers: [ApiCredentialResolver, TokensResolver],
  exports: [TokensCoreModule],
})
export class TokensModule {}
