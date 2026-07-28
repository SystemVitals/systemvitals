import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import type { ApiPrincipal } from '../tokens/api-principal';

export interface JwtUser {
  userId: string;
  email: string;
  impersonatedBy?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    cfg: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: cfg.getOrThrow<string>('JWT_SECRET'),
    });
  }
  async validate(payload: {
    sub: string;
    email: string;
    act?: string;
  }): Promise<ApiPrincipal> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { suspendedAt: true },
    });
    if (!user || user.suspendedAt)
      throw new UnauthorizedException('Account suspended');
    return {
      userId: payload.sub,
      email: payload.email,
      impersonatedBy: payload.act,
      authKind: 'session',
    };
  }
}
