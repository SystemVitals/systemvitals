import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { buildApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { BillingService } from '../src/billing/billing.service';
import { cleanupTestUsers } from './cleanup-test-users';
import { hashToken } from '../src/tokens/token.util';

type Response<T> = { data?: T; errors?: { message: string }[] };
type Created = {
  id: string;
  plaintext: string;
  scopes: string[];
  expiresAt: string | null;
};
const emails = ['pat-owner@systemvitals.test', 'pat-other@systemvitals.test'];

describe('account personal access tokens (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let session: string;
  let otherSession: string;
  let userId: string;
  let otherUserId: string;
  let organizationId: string;
  let otherOrganizationId: string;
  let credential: Created;
  let checkout: jest.SpyInstance;
  let portal: jest.SpyInstance;

  async function gql<T>(
    token: string,
    query: string,
    variables?: Record<string, unknown>,
    url = '/graphql',
  ): Promise<Response<T>> {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: { query, variables },
    });
    return JSON.parse(response.body) as Response<T>;
  }
  async function create(name = 'Account agent') {
    const result = await gql<{ createPersonalAccessToken: Created }>(
      session,
      `mutation($name:String!){ createPersonalAccessToken(name:$name,expirationDays:30){id plaintext scopes expiresAt} }`,
      { name },
    );
    expect(result.errors).toBeUndefined();
    return result.data!.createPersonalAccessToken;
  }

  beforeAll(async () => {
    app = await buildApp();
    // Only test service delegation here; never contact a billing provider.
    checkout = jest
      .spyOn(app.get(BillingService), 'createCheckout')
      .mockResolvedValue({ url: 'https://checkout.example.test' });
    portal = jest
      .spyOn(app.get(BillingService), 'createPortal')
      .mockResolvedValue({ url: 'https://portal.example.test' });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await cleanupTestUsers(prisma, emails);
    const sessions: string[] = [];
    for (const email of emails) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password: 'test-password-123' },
      });
      expect(response.statusCode).toBe(201);
      sessions.push((JSON.parse(response.body) as { token: string }).token);
    }
    [session, otherSession] = sessions;
    const users = await Promise.all(
      emails.map((email) =>
        prisma.user.findUniqueOrThrow({
          where: { email },
          include: { memberships: true },
        }),
      ),
    );
    [userId, otherUserId] = users.map((user) => user.id);
    [organizationId, otherOrganizationId] = users.map(
      (user) => user.memberships[0].organizationId,
    );
  });
  beforeEach(async () => {
    credential = await create();
    checkout.mockClear();
    portal.mockClear();
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    try {
      await cleanupTestUsers(prisma, emails);
    } finally {
      await app.close();
    }
  });

  it('stores only the hash, reports ACCOUNT, and never lists the secret', async () => {
    const record = await prisma.apiToken.findUniqueOrThrow({
      where: { id: credential.id },
    });
    expect(record.tokenHash).toBe(hashToken(credential.plaintext));
    expect(record.projectId).toBeNull();
    expect(record.scopes).toEqual(['account:manage']);
    expect(record.expiresAt!.getTime()).toBeGreaterThan(
      Date.now() + 29 * 86400000,
    );
    const discovery = await gql(
      credential.plaintext,
      `{apiCredential{authKind credentialMode capabilities organizationId projectId} me{id} mySubscription{plan} organizationCheckAllowance(organizationId:"${organizationId}"){used limit remaining}}`,
    );
    expect(discovery.errors).toBeUndefined();
    expect(discovery.data).toMatchObject({
      apiCredential: {
        authKind: 'api-token',
        credentialMode: 'ACCOUNT',
        organizationId: null,
        projectId: null,
      },
      me: { id: userId },
    });
    const history = await gql(
      session,
      `{apiTokens{id name prefix scopes lastUsedAt}}`,
    );
    expect(history.errors).toBeUndefined();
    expect(JSON.stringify(history)).not.toContain(credential.plaintext);
    expect(
      (
        await prisma.apiToken.findUniqueOrThrow({
          where: { id: credential.id },
        })
      ).lastUsedAt,
    ).not.toBeNull();
  });

  it('creates a new organization, moves checks, and manages channels and status pages', async () => {
    const created = await gql<{ createOrganization: { id: string } }>(
      credential.plaintext,
      `mutation{createOrganization(name:"Agent workspace"){id}}`,
    );
    expect(created.errors).toBeUndefined();
    const destination = created.data!.createOrganization.id;
    const check = await gql<{ createCheck: { id: string } }>(
      credential.plaintext,
      `mutation{createCheck(organizationId:"${organizationId}",name:"PAT heartbeat",periodSeconds:300,graceSeconds:60){id}}`,
    );
    expect(check.errors).toBeUndefined();
    const checkId = check.data!.createCheck.id;
    const moved = await gql(
      credential.plaintext,
      `mutation{moveCheck(checkId:"${checkId}",destinationOrganizationId:"${destination}"){id organizationId}}`,
    );
    expect(moved.errors).toBeUndefined();
    expect(moved.data).toMatchObject({
      moveCheck: { id: checkId, organizationId: destination },
    });
    const channel = await gql<{ createChannel: { id: string } }>(
      credential.plaintext,
      `mutation($config:String!){createChannel(organizationId:"${destination}",type:"WEBHOOK",configJson:$config){id}}`,
      { config: JSON.stringify({ url: 'https://example.test/notify' }) },
    );
    expect(channel.errors).toBeUndefined();
    const page = await gql<{ createStatusPage: { id: string } }>(
      credential.plaintext,
      `mutation{createStatusPage(organizationId:"${destination}",slug:"pat-status",title:"Agent status",checkIds:["${checkId}"]){id}}`,
    );
    expect(page.errors).toBeUndefined();
    const pageId = page.data!.createStatusPage.id;
    expect(
      (
        await gql(
          credential.plaintext,
          `mutation{updateStatusPage(id:"${pageId}",title:"Updated status"){title}}`,
        )
      ).data,
    ).toMatchObject({ updateStatusPage: { title: 'Updated status' } });
    expect(
      (
        await gql(
          credential.plaintext,
          `query{statusPages(organizationId:"${destination}"){id} channels(organizationId:"${destination}"){id}}`,
        )
      ).errors,
    ).toBeUndefined();
    expect(
      (
        await gql(
          credential.plaintext,
          `mutation{deleteStatusPage(id:"${pageId}") deleteChannel(id:"${channel.data!.createChannel.id}") deleteCheck(id:"${checkId}") deleteOrganization(organizationId:"${destination}")}`,
        )
      ).errors,
    ).toBeUndefined();
  });

  it('does not access another account until membership is granted, and loses access on removal', async () => {
    const query = `query{checks(organizationId:"${otherOrganizationId}"){id}}`;
    expect((await gql(credential.plaintext, query)).errors).toBeDefined();
    const membership = await prisma.membership.create({
      data: { userId, organizationId: otherOrganizationId, role: 'MEMBER' },
    });
    try {
      expect((await gql(credential.plaintext, query)).errors).toBeUndefined();
      const rename = `mutation{updateOrganization(organizationId:"${otherOrganizationId}",name:"Renamed by agent"){id}}`;
      expect((await gql(credential.plaintext, rename)).errors).toBeDefined();
      await prisma.membership.update({
        where: { id: membership.id },
        data: { role: 'ADMIN' },
      });
      expect((await gql(credential.plaintext, rename)).errors).toBeUndefined();
      await prisma.membership.update({
        where: { id: membership.id },
        data: { role: 'MEMBER' },
      });
      expect((await gql(credential.plaintext, rename)).errors).toBeDefined();
    } finally {
      await prisma.membership.delete({ where: { id: membership.id } });
    }
    expect((await gql(credential.plaintext, query)).errors).toBeDefined();
    expect((await gql(otherSession, `{me{id}}`)).data).toMatchObject({
      me: { id: otherUserId },
    });
  });

  it.each([
    `{apiTokens{id}}`,
    `mutation{createApiToken(name:"Nested",scopes:["write"]){id}}`,
    `mutation{createPersonalAccessToken(name:"Nested"){id}}`,
    `mutation{createScopedApiToken(input:{name:"Nested",organizationId:"unknown",capabilities:["checks:read","checks:write"]}){id}}`,
    `mutation{revokeApiToken(id:"unknown")}`,
    `mutation{setPassword(newPassword:"replacement-password")}`,
  ])('denies credential and password administration %#', async (query) => {
    expect((await gql(credential.plaintext, query)).errors).toBeDefined();
  });

  it('cannot inherit platform administration from an admin issuer', async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { isAdmin: true },
    });
    try {
      expect(
        (
          await gql(
            credential.plaintext,
            `{adminPing}`,
            undefined,
            '/admin/graphql',
          )
        ).errors,
      ).toBeDefined();
      expect(
        (await gql(session, `{adminPing}`, undefined, '/admin/graphql')).errors,
      ).toBeUndefined();
    } finally {
      await prisma.user.update({
        where: { id: userId },
        data: { isAdmin: false },
      });
    }
  });

  it.each(['revoked', 'expired', 'suspended'])(
    'rejects a %s credential',
    async (reason) => {
      if (reason === 'revoked') {
        expect(
          (
            await gql(
              session,
              `mutation{revokeApiToken(id:"${credential.id}")}`,
            )
          ).errors,
        ).toBeUndefined();
      } else if (reason === 'expired') {
        await prisma.apiToken.update({
          where: { id: credential.id },
          data: { expiresAt: new Date(0) },
        });
      } else {
        await prisma.user.update({
          where: { id: userId },
          data: { suspendedAt: new Date() },
        });
      }
      try {
        expect(
          (await gql(credential.plaintext, `{me{id}}`)).errors,
        ).toBeDefined();
      } finally {
        if (reason === 'suspended')
          await prisma.user.update({
            where: { id: userId },
            data: { suspendedAt: null },
          });
      }
    },
  );

  it('issues hosted billing links for its own account', async () => {
    expect(
      (
        await gql(
          credential.plaintext,
          `mutation{createBillingCheckout(plan:"FLEET",interval:"year"){url} createBillingPortal{url}}`,
        )
      ).errors,
    ).toBeUndefined();
    expect(checkout).toHaveBeenCalledWith(userId, 'FLEET', 'year');
    expect(portal).toHaveBeenCalledWith(userId);
  });

  it('keeps old broad and scoped tokens out of new billing operations', async () => {
    const project = await prisma.project.findUniqueOrThrow({
      where: { organizationId },
    });
    const old = await gql<{ createApiToken: Created }>(
      session,
      `mutation{createApiToken(name:"Legacy",scopes:["write"]){plaintext}}`,
    );
    const scoped = await gql<{ createScopedApiToken: Created }>(
      session,
      `mutation{createScopedApiToken(input:{name:"Scoped",projectId:"${project.id}",capabilities:["checks:read","checks:write"]}){plaintext}}`,
    );
    for (const token of [
      old.data!.createApiToken.plaintext,
      scoped.data!.createScopedApiToken.plaintext,
    ]) {
      expect(
        (await gql(token, `mutation{createBillingPortal{url}}`)).errors,
      ).toBeDefined();
    }
    expect(portal).not.toHaveBeenCalled();
  });

  it('rejects impersonated sessions for issuance and billing', async () => {
    const impersonated = app
      .get(JwtService)
      .sign({ sub: userId, email: emails[0], act: otherUserId });
    expect(
      (
        await gql(
          impersonated,
          `mutation{createPersonalAccessToken(name:"Impersonated"){id}}`,
        )
      ).errors,
    ).toBeDefined();
    expect(
      (await gql(impersonated, `mutation{createBillingPortal{url}}`)).errors,
    ).toBeDefined();
    expect(portal).not.toHaveBeenCalled();
  });
});
