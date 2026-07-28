import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { cleanupTestUsers } from './cleanup-test-users';
import * as argon2 from 'argon2';

interface GqlErrors {
  message?: string;
}
interface GqlResponse<T> {
  data?: T;
  errors?: GqlErrors[];
}

async function signup(
  app: NestFastifyApplication,
  email: string,
  password: string,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password },
  });
  return (JSON.parse(res.body) as { token: string }).token;
}

async function login(
  app: NestFastifyApplication,
  email: string,
  password: string,
): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });
  return res.statusCode;
}

async function gql<T>(
  app: NestFastifyApplication,
  token: string,
  query: string,
  variables?: unknown,
): Promise<GqlResponse<T>> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { authorization: `Bearer ${token}` },
    payload: { query, variables },
  });
  return JSON.parse(res.body) as GqlResponse<T>;
}

const SET_PASSWORD = `mutation($n:String!,$c:String){ setPassword(newPassword:$n, currentPassword:$c) }`;
const ME_CREDS = `{ me { id email hasPassword googleLinked } }`;

describe('setPassword mutation (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  const base = 'set-password@systemvitals.test';
  const emailFor = (tag: string) => base.replace('@', `+${tag}@`);
  const googleEmail = 'set-password-google@systemvitals.test';
  const allEmails = [
    emailFor('reflect'),
    emailFor('wrongcurrent'),
    emailFor('tooshort'),
    emailFor('change'),
    emailFor('apitoken'),
    googleEmail,
  ];

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    await cleanupTestUsers(prisma, allEmails);
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, allEmails);
    } finally {
      await app.close();
    }
  });

  it('me reflects real DB state: a password signup has hasPassword=true, googleLinked=false', async () => {
    const email = emailFor('reflect');
    const token = await signup(app, email, 'supersecret1');
    const res = await gql<{
      me: { hasPassword: boolean; googleLinked: boolean };
    }>(app, token, ME_CREDS);
    expect(res.errors).toBeUndefined();
    expect(res.data?.me.hasPassword).toBe(true);
    expect(res.data?.me.googleLinked).toBe(false);
  });

  it('rejects a wrong current password and leaves the password unchanged', async () => {
    const email = emailFor('wrongcurrent');
    const token = await signup(app, email, 'supersecret1');
    const res = await gql<{ setPassword: boolean }>(app, token, SET_PASSWORD, {
      n: 'brandnewpass1',
      c: 'totallywrong',
    });
    expect(res.data).toBeFalsy();
    expect(res.errors).toBeDefined();

    expect(await login(app, email, 'supersecret1')).toBe(201);
  });

  it('rejects a newPassword shorter than 8 characters (MinLength validation actually runs)', async () => {
    const email = emailFor('tooshort');
    const token = await signup(app, email, 'supersecret1');
    const res = await gql<{ setPassword: boolean }>(app, token, SET_PASSWORD, {
      n: 'short1', // 6 chars — deliberately below @MinLength(8)
      c: 'supersecret1',
    });
    expect(res.data).toBeFalsy();
    expect(res.errors).toBeDefined();

    // Proof the rejection was real, not just a reported error: the old
    // password still works, and the too-short one was never set.
    expect(await login(app, email, 'supersecret1')).toBe(201);
    expect(await login(app, email, 'short1')).toBe(401);
  });

  it('changes the password when the current password is correct, and the new password then logs in', async () => {
    const email = emailFor('change');
    const token = await signup(app, email, 'supersecret1');
    const res = await gql<{ setPassword: boolean }>(app, token, SET_PASSWORD, {
      n: 'brandnewpass1',
      c: 'supersecret1',
    });
    expect(res.errors).toBeUndefined();
    expect(res.data?.setPassword).toBe(true);

    expect(await login(app, email, 'brandnewpass1')).toBe(201);
    expect(await login(app, email, 'supersecret1')).toBe(401);
  });

  it('an ApiToken cannot call setPassword — JwtAuthGuard rejects it even though the token authenticates other GraphQL operations', async () => {
    const email = emailFor('apitoken');
    const token = await signup(app, email, 'supersecret1');
    const created = await gql<{ createApiToken: { plaintext: string } }>(
      app,
      token,
      `mutation{ createApiToken(name:"tmp", scopes:["read","write"]){ plaintext } }`,
    );
    const plaintext = created.data!.createApiToken.plaintext;

    // Sanity: the ApiToken really does authenticate ApiAuthGuard-protected ops.
    const me = await gql<{ me: { id: string } }>(
      app,
      plaintext,
      `{ me { id } }`,
    );
    expect(me.errors).toBeUndefined();
    expect(me.data?.me.id).toBeDefined();

    // But setPassword uses JwtAuthGuard, which does not accept an ApiToken.
    const res = await gql<{ setPassword: boolean }>(
      app,
      plaintext,
      SET_PASSWORD,
      {
        n: 'anotherpass1',
        c: 'supersecret1',
      },
    );
    expect(res.data).toBeFalsy();
    expect(res.errors).toBeDefined();

    // The password was not touched by the rejected call.
    expect(await login(app, email, 'supersecret1')).toBe(201);
  });

  it('a Google-only user (no password) can set an initial password without a currentPassword, and hasPassword flips to true', async () => {
    const user = await prisma.user.create({
      data: {
        email: googleEmail,
        googleId: 'g-set-password-test',
        passwordHash: null,
      },
    });
    const jwt = jwtService.sign({ sub: user.id, email: googleEmail });

    const before = await gql<{
      me: { hasPassword: boolean; googleLinked: boolean };
    }>(app, jwt, ME_CREDS);
    expect(before.data?.me.hasPassword).toBe(false);
    expect(before.data?.me.googleLinked).toBe(true);

    const res = await gql<{ setPassword: boolean }>(app, jwt, SET_PASSWORD, {
      n: 'newlyaddedpass1',
    });
    expect(res.errors).toBeUndefined();
    expect(res.data?.setPassword).toBe(true);

    const dbUser = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(dbUser.passwordHash).not.toBeNull();
    expect(await argon2.verify(dbUser.passwordHash!, 'newlyaddedpass1')).toBe(
      true,
    );

    const after = await gql<{
      me: { hasPassword: boolean; googleLinked: boolean };
    }>(app, jwt, ME_CREDS);
    expect(after.data?.me.hasPassword).toBe(true);
    expect(after.data?.me.googleLinked).toBe(true);
  });
});
