import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';

async function signup(app: NestFastifyApplication, email: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: 'supersecret1' },
  });
  return (JSON.parse(r.body) as { token: string }).token;
}

async function gql(
  app: NestFastifyApplication,
  token: string,
  query: string,
  variables?: unknown,
) {
  const r = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { authorization: `Bearer ${token}` },
    payload: { query, variables },
  });
  return JSON.parse(r.body) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message: string }>;
  };
}

const ME_ORGS = `{ me { organizations { id name role } } }`;

interface MeOrgs {
  data: { me: { organizations: Array<{ id: string; role: string }> } };
}

describe('me.organizations.role (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  const email = 'me-org-role@systemvitals.com';
  const shareOwner = 'me-org-role+shareowner@systemvitals.com';
  const memberEmail = 'me-org-role+member@systemvitals.com';
  const emails = [email, shareOwner, memberEmail];

  async function cleanupFixtures() {
    const users = await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true },
    });
    const userIds = users.map(({ id }) => id);
    await prisma.organization.deleteMany({
      where: { creatorUserId: { in: userIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await cleanupFixtures();
  });

  afterAll(async () => {
    await cleanupFixtures();
    await app.close();
  });

  it('reports OWNER for the organization created at signup', async () => {
    const token = await signup(app, email);

    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { authorization: `Bearer ${token}` },
      payload: { query: ME_ORGS },
    });

    const body = JSON.parse(res.body) as {
      data: { me: { organizations: Array<{ role: string }> } };
    };
    expect(body.data.me.organizations).toHaveLength(1);
    expect(body.data.me.organizations[0].role).toBe('OWNER');
  });

  // The test above passes equally against a hardcoded 'OWNER', or against an
  // implementation that returned the organization's creator's role rather than
  // the caller's. This one does not: two users read the SAME organization id
  // and must each see their OWN role.
  it('reports each viewer their own role for the same organization', async () => {
    const ownerToken = await signup(app, shareOwner);
    const memberToken = await signup(app, memberEmail);

    const ownerMe = (await gql(app, ownerToken, ME_ORGS)) as unknown as MeOrgs;
    const orgId = ownerMe.data.me.organizations[0].id;

    const invited = await gql(
      app,
      ownerToken,
      `mutation($organizationId: ID!, $email: String!, $role: String!) {
        inviteMember(organizationId: $organizationId, email: $email, role: $role) { token }
      }`,
      { organizationId: orgId, email: memberEmail, role: 'MEMBER' },
    );
    expect(invited.errors).toBeUndefined();
    const inviteToken = (invited.data?.inviteMember as { token: string }).token;

    const accepted = await gql(
      app,
      memberToken,
      `mutation($token: String!) { acceptInvite(token: $token) { id role } }`,
      { token: inviteToken },
    );
    expect(accepted.errors).toBeUndefined();

    const ownerAfter = (await gql(
      app,
      ownerToken,
      ME_ORGS,
    )) as unknown as MeOrgs;
    const memberAfter = (await gql(
      app,
      memberToken,
      ME_ORGS,
    )) as unknown as MeOrgs;

    const ownerView = ownerAfter.data.me.organizations.find(
      (o) => o.id === orgId,
    );
    const memberView = memberAfter.data.me.organizations.find(
      (o) => o.id === orgId,
    );

    // Same organization id, two different viewers, two different answers.
    expect(ownerView?.role).toBe('OWNER');
    expect(memberView?.role).toBe('MEMBER');
  });
});
