import type { JwtUser } from '../auth/jwt.strategy';

export type TokenCapability = 'checks:read' | 'checks:write';

export interface ApiTokenMetadata {
  id: string;
  projectId: string | null;
  capabilities: readonly TokenCapability[];
  legacyScopes: readonly string[];
}

export type SessionPrincipal = JwtUser & {
  authKind: 'session';
  apiToken?: never;
};

export type ApiTokenPrincipal = JwtUser & {
  authKind: 'api-token';
  apiToken: ApiTokenMetadata;
};

export type ApiPrincipal = SessionPrincipal | ApiTokenPrincipal;
