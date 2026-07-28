import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { cleanupTestUsers } from './cleanup-test-users';
import { JwtService } from '@nestjs/jwt';

const email = 'me-isadmin@systemvitals.test';

async function signup(app: NestFastifyApplication): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: 'supersecret1!' },
  });
  return (JSON.parse(res.body) as { token: string }).token;
}

async function queryMe(
  app: NestFastifyApplication,
  token: string,
): Promise<{ data?: { me?: { isAdmin?: boolean } }; errors?: unknown[] }> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    payload: { query: '{ me { id email isAdmin } }' },
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
  return JSON.parse(res.body) as {
    data?: { me?: { isAdmin?: boolean } };
    errors?: unknown[];
  };
}

describe('me.isAdmin (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    await cleanupTestUsers(prisma, email);
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, email);
    } finally {
      await app.close();
    }
  });

  it('freshly signed-up user has isAdmin === false', async () => {
    const token = await signup(app);
    const body = await queryMe(app, token);
    expect(body.errors).toBeUndefined();
    expect(body.data?.me?.isAdmin).toBe(false);
  });

  it('after DB-setting isAdmin=true, me.isAdmin returns true', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.user.update({
      where: { id: user.id },
      data: { isAdmin: true },
    });
    const freshToken = jwtService.sign({ sub: user.id, email });
    const body = await queryMe(app, freshToken);
    expect(body.errors).toBeUndefined();
    expect(body.data?.me?.isAdmin).toBe(true);
  });
});
