import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';

describe('JwtStrategy', () => {
  it('returns a session principal preserving the impersonation actor', async () => {
    const config = {
      getOrThrow: jest
        .fn()
        .mockReturnValue('test-jwt-secret-at-least-16-chars'),
    } as unknown as ConfigService;
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ suspendedAt: null }),
      },
    } as unknown as PrismaService;
    const strategy = new JwtStrategy(config, prisma);

    await expect(
      strategy.validate({
        sub: 'user-1',
        email: 'user@example.com',
        act: 'admin-1',
      }),
    ).resolves.toEqual({
      userId: 'user-1',
      email: 'user@example.com',
      impersonatedBy: 'admin-1',
      authKind: 'session',
    });
  });
});
